import type { CheckResult, ProbeCheck, ProbeStep } from "./protocol";

const STEP_TIMEOUT_MS = 8_000;
// A fresh Preview can briefly answer 5xx while its Durable Objects spin up. Infrastructure
// errors (network failure, unexpected 5xx) rerun the whole check with a fresh run id;
// a real assertion failure is never retried, so verdicts stay deterministic.
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

type StepFailure = { message: string; transient: boolean };

/** Runs one check against a preview origin. Deterministic given the app's seed data. */
export async function runCheck(check: ProbeCheck, origin: string): Promise<CheckResult> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const failure = await runOnce(check, origin);
    if (!failure) return { held: true, detail: "ok", ms: Date.now() - started };
    if (!failure.transient || attempt >= TRANSIENT_RETRIES) {
      return { held: false, detail: failure.message, ms: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

async function runOnce(check: ProbeCheck, origin: string): Promise<StepFailure | null> {
  const run = crypto.randomUUID();
  const vars: Record<string, unknown> = {};
  for (const [i, step] of check.steps.entries()) {
    const failure = await runStep(step, origin, run, vars);
    if (failure) return { ...failure, message: `step ${i + 1}: ${failure.message}` };
  }
  return null;
}

async function runStep(
  step: ProbeStep,
  origin: string,
  run: string,
  vars: Record<string, unknown>,
): Promise<StepFailure | null> {
  const fail = (message: string, transient = false): StepFailure => ({ message, transient });
  if (step.repeat && step.repeat > 1) return runRepeated(step, origin, run, vars, fail);
  const method = step.method ?? "GET";
  const url = new URL(fill(step.path, vars) as string, origin);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "x-canon-run": run, "content-type": "application/json" },
      body: step.body === undefined ? undefined : JSON.stringify(fill(step.body, vars)),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`${method} ${url.pathname} failed: ${(err as Error).message}`, true);
  }
  const text = await res.text();
  const expect = step.expect ?? {};

  const statuses = expect.status === undefined ? null : [expect.status].flat();
  if (statuses && !statuses.includes(res.status)) {
    return fail(`${method} ${url.pathname} returned ${res.status}, expected ${statuses.join(" or ")}`, res.status >= 500);
  }
  if (res.status >= 500 && !statuses) return fail(`${method} ${url.pathname} returned ${res.status}`, true);
  if (expect.bodyIncludes && !text.includes(expect.bodyIncludes)) {
    return fail(`${method} ${url.pathname} body does not include "${expect.bodyIncludes}"`);
  }
  if (expect.json || step.save) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(`${method} ${url.pathname} did not return JSON`);
    }
    for (const [path, want] of Object.entries(expect.json ?? {})) {
      const got = pick(json, path);
      if (isExists(want)) {
        if ((got !== undefined) !== want.$exists) return fail(`${path} ${want.$exists ? "missing" : "present"}`);
      } else if (!same(got, fill(want, vars))) {
        return fail(`${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(fill(want, vars))}`);
      }
    }
    for (const [name, path] of Object.entries(step.save ?? {})) vars[name] = pick(json, path);
  }
  return null;
}

// A latency budget: one warm-up request, then `repeat` timed requests; every one must meet the
// status expectation and the p95 must fit the budget. Slowness is marked transient, so a one-off
// network blip reruns the check, while a genuinely slow world fails every time.
async function runRepeated(
  step: ProbeStep,
  origin: string,
  run: string,
  vars: Record<string, unknown>,
  fail: (message: string, transient?: boolean) => StepFailure,
): Promise<StepFailure | null> {
  const method = step.method ?? "GET";
  const url = new URL(fill(step.path, vars) as string, origin);
  const init = () => ({
    method,
    headers: { "x-canon-run": run, "content-type": "application/json" },
    body: step.body === undefined ? undefined : JSON.stringify(fill(step.body, vars)),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  const statuses = step.expect?.status === undefined ? null : [step.expect.status].flat();
  try {
    await (await fetch(url, init())).arrayBuffer();
    const times: number[] = [];
    for (let i = 0; i < (step.repeat ?? 1); i++) {
      const t0 = Date.now();
      const res = await fetch(url, init());
      await res.arrayBuffer();
      times.push(Date.now() - t0);
      if (statuses && !statuses.includes(res.status)) {
        return fail(`${method} ${url.pathname} returned ${res.status}, expected ${statuses.join(" or ")}`, res.status >= 500);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];
    const budget = step.expect?.p95Ms;
    if (budget !== undefined && p95 > budget) return fail(`${method} ${url.pathname} p95 is ${p95} ms, budget ${budget} ms`, true);
    return null;
  } catch (err) {
    return fail(`${method} ${url.pathname} failed: ${(err as Error).message}`, true);
  }
}

function pick(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// Replaces whole-string "{{var}}" with the saved value (keeping its type) and
// inline "{{var}}" occurrences with their string form.
function fill(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name]));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

function isExists(v: unknown): v is { $exists: boolean } {
  return !!v && typeof v === "object" && "$exists" in v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
