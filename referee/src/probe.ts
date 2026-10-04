import type { Check, CheckResult, ProbeStep } from "./protocol";

const STEP_TIMEOUT_MS = 8_000;

/** Runs one check against a preview origin. Deterministic given the app's seed data. */
export async function runCheck(check: Check, origin: string): Promise<CheckResult> {
  const started = Date.now();
  const run = crypto.randomUUID();
  const vars: Record<string, unknown> = {};
  for (const [i, step] of check.steps.entries()) {
    const failure = await runStep(step, origin, run, vars);
    if (failure) return { held: false, detail: `step ${i + 1}: ${failure}`, ms: Date.now() - started };
  }
  return { held: true, detail: "ok", ms: Date.now() - started };
}

async function runStep(
  step: ProbeStep,
  origin: string,
  run: string,
  vars: Record<string, unknown>,
): Promise<string | null> {
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
    return `${method} ${url.pathname} failed: ${(err as Error).message}`;
  }
  const text = await res.text();
  const expect = step.expect ?? {};

  const statuses = expect.status === undefined ? null : [expect.status].flat();
  if (statuses && !statuses.includes(res.status)) {
    return `${method} ${url.pathname} returned ${res.status}, expected ${statuses.join(" or ")}`;
  }
  if (expect.bodyIncludes && !text.includes(expect.bodyIncludes)) {
    return `${method} ${url.pathname} body does not include "${expect.bodyIncludes}"`;
  }
  if (expect.json || step.save) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return `${method} ${url.pathname} did not return JSON`;
    }
    for (const [path, want] of Object.entries(expect.json ?? {})) {
      const got = pick(json, path);
      if (isExists(want)) {
        if ((got !== undefined) !== want.$exists) return `${path} ${want.$exists ? "missing" : "present"}`;
      } else if (!same(got, fill(want, vars))) {
        return `${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(fill(want, vars))}`;
      }
    }
    for (const [name, path] of Object.entries(step.save ?? {})) vars[name] = pick(json, path);
  }
  return null;
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
