import type { CheckResult, ProbeCheck, ProbeStep } from "./protocol";

const STEP_TIMEOUT_MS = 8_000;
// A fresh Preview can briefly answer 5xx while its Durable Objects spin up. Infrastructure
// errors (network failure, unexpected 5xx) rerun the whole check with a fresh run id;
// a real assertion failure is never retried, so verdicts stay deterministic.
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

type StepFailure = { message: string; transient: boolean };

/**
 * Runs one check against an origin. Its random inputs are drawn from `seed`: the referee passes the
 * commit and the fact, so the same commit always gets the same inputs. Without a seed they are fresh.
 */
export async function runCheck(check: ProbeCheck, origin: string, seed: string = crypto.randomUUID()): Promise<CheckResult> {
  const started = Date.now();
  for (let retry = 0; ; retry++) {
    const failure = await runSamples(check, origin, seed);
    if (!failure) return { held: true, detail: "ok", ms: Date.now() - started };
    if (!failure.transient || retry >= TRANSIENT_RETRIES) {
      return { held: false, detail: failure.message, ms: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

// Each sample draws its own inputs and runs every step in a run of its own; all of them must hold.
async function runSamples(check: ProbeCheck, origin: string, seed: string): Promise<StepFailure | null> {
  const next = random(seed);
  const samples = check.samples ?? 1;
  for (let s = 0; s < samples; s++) {
    const inputs = draw(check.vars, next);
    const failure = await runOnce(check, origin, inputs);
    if (failure) {
      const given = Object.entries(inputs).map(([name, v]) => `${name} = ${label(v)}`).join(", ");
      return { ...failure, message: `${samples > 1 ? `sample ${s + 1}, ` : ""}${failure.message}${given ? ` (with ${given})` : ""}` };
    }
  }
  return null;
}

async function runOnce(check: ProbeCheck, origin: string, inputs: Record<string, unknown>): Promise<StepFailure | null> {
  // An isolated run gets state of its own through the x-canon-run header; a visitor run sends no Canon header.
  const run = check.isolate === false ? null : crypto.randomUUID();
  const vars: Record<string, unknown> = { ...inputs };
  for (const [i, step] of check.steps.entries()) {
    const failure = await runStep(step, origin, run, vars);
    if (failure) return { ...failure, message: `step ${i + 1}: ${failure.message}` };
  }
  return null;
}

async function runStep(
  step: ProbeStep,
  origin: string,
  run: string | null,
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
      headers: headersFor(run, step.body !== undefined),
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
// network blip reruns the check, while a genuinely slow attempt fails every time.
async function runRepeated(
  step: ProbeStep,
  origin: string,
  run: string | null,
  vars: Record<string, unknown>,
  fail: (message: string, transient?: boolean) => StepFailure,
): Promise<StepFailure | null> {
  const method = step.method ?? "GET";
  const url = new URL(fill(step.path, vars) as string, origin);
  const init = () => ({
    method,
    headers: headersFor(run, step.body !== undefined),
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

function headersFor(run: string | null, hasBody: boolean): Record<string, string> {
  return { ...(run ? { "x-canon-run": run } : {}), ...(hasBody ? { "content-type": "application/json" } : {}) };
}

// Replaces a whole-string "{{expr}}" with its value (keeping its type) and inline "{{expr}}" with
// its string form.
function fill(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([^{}]+)\}\}$/);
    if (whole) return evaluate(whole[1], vars);
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, expr) => String(evaluate(expr, vars)));
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

// An expression is a value ("qty", "item.id") or a sum of products of numbers ("qa * a.cents + qb * b.cents").
function evaluate(expr: string, vars: Record<string, unknown>): unknown {
  if (!/[+*]/.test(expr)) return pick(vars, expr.trim());
  let sum = 0;
  for (const term of expr.split("+")) {
    let product = 1;
    for (const factor of term.split("*").map((f) => f.trim())) {
      const n = /^\d+(\.\d+)?$/.test(factor) ? Number(factor) : pick(vars, factor);
      if (typeof n !== "number") return undefined;
      product *= n;
    }
    sum += product;
  }
  return sum;
}

/** The input names a check's templates use ("{{qa * a.cents}}" uses qa and a), so a check can be validated. */
export function templateNames(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\{\{([^{}]+)\}\}/g)].flatMap(([, expr]) =>
      expr.split(/[+*]/).map((f) => f.trim()).filter((f) => f && !/^\d+(\.\d+)?$/.test(f)).map((f) => f.split(".")[0]),
    );
  }
  if (Array.isArray(value)) return value.flatMap(templateNames);
  if (value && typeof value === "object") return Object.values(value).flatMap(templateNames);
  return [];
}

function draw(specs: ProbeCheck["vars"], next: () => number): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs ?? {})) {
    inputs[name] = "int" in spec
      ? spec.int[0] + Math.floor(next() * (spec.int[1] - spec.int[0] + 1))
      : spec.oneOf[Math.floor(next() * spec.oneOf.length)];
  }
  return inputs;
}

// How an input reads in a verdict: an object by its id, anything else as itself.
function label(v: unknown): string {
  if (v && typeof v === "object" && "id" in v) return String((v as { id: unknown }).id);
  return typeof v === "string" ? v : JSON.stringify(v);
}

// A small seeded generator (an FNV-1a hash of the seed driving mulberry32): one seed, one sequence of draws.
function random(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
