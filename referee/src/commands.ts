import type { CheckResult } from "./protocol";

// A CiRunnerFailure carries the command's output; read it without importing the CI package,
// so these helpers also run under plain Node in scripts/test-commands.ts.
const outputOf = (err: unknown) => {
  const e = err as { output?: unknown; message?: unknown } | null;
  return typeof e?.output === "string" ? e.output : String(e?.message ?? err);
};

// Running command facts (lint, types, tests...) in the CI container, and reading their results.

export const PLATFORM_RETRIES = 3;

/**
 * A proposed command fact must fail on the commit its world forked from, or it is not a new fact. CI rebuilds
 * that commit from the world's checkout: these are the files the world changed, as they were at the fork
 * (base64), or null where the world added the file.
 */
export interface Novelty {
  factId: string;
  run: string;
  files: Array<{ path: string; b64: string | null }>;
}

// One shell script runs every command fact and always exits 0; each fact reports its own exit code,
// and a failing fact prints its last output lines between markers. Commands travel base64-encoded.
export function commandScript(commands: Array<{ factId: string; run: string }>, base?: Novelty | null): string {
  const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const lines = [
    "set +e",
    'fact() { cmd="$(printf %s "$2" | base64 -d)"; out="$(bash -c "$cmd" 2>&1)"; code=$?; echo "::canon-fact::$1::$code"; if [ "$code" -ne 0 ]; then echo "::canon-out::$1::begin"; printf "%s\\n" "$out" | tail -n 40; echo "::canon-out::$1::end"; fi; }',
    ...commands.map((c) => `fact ${c.factId} ${b64(c.run)}`),
    ...(base ? baseScript(base, b64) : []),
    "exit 0",
  ];
  return `bash -c ${shellQuote(lines.join("\n"))}`;
}

// Copies the world's checkout (sharing its node_modules), puts every changed file back as it was at the fork,
// and runs the claimed fact's command there. Only its exit code is reported. If the copy fails, the command
// fails too, so a broken rebuild never refuses a fact.
function baseScript(base: Novelty, b64: (text: string) => string): string[] {
  const at = (path: string) => `/tmp/canon-base/${shellQuote(path)}`;
  return [
    'here="$PWD"; rm -rf /tmp/canon-base && mkdir -p /tmp/canon-base && tar --exclude=./node_modules -cf - . | tar -C /tmp/canon-base -xf - && ln -s "$here/node_modules" /tmp/canon-base/node_modules',
    ...base.files.map((f) => (f.b64 === null ? `rm -f ${at(f.path)}` : `mkdir -p "$(dirname ${at(f.path)})" && printf %s ${f.b64} | base64 -d > ${at(f.path)}`)),
    `cd /tmp/canon-base && bash -c "$(printf %s ${b64(base.run)} | base64 -d)" >/dev/null 2>&1; echo "::canon-base::${base.factId}::$?"; cd "$here"`,
  ];
}

/** Whether the claimed fact's command passed on the commit its world forked from (null: it did not report). */
export function heldOnBase(base: Novelty, stdout: string): boolean | null {
  const code = stdout.match(new RegExp(`::canon-base::${base.factId}::(\\d+)`))?.[1];
  return code === undefined ? null : code === "0";
}

export function parseCommandResults(commands: Array<{ factId: string; run: string }>, stdout: string): Record<string, CheckResult> {
  const results: Record<string, CheckResult> = {};
  for (const { factId, run } of commands) {
    const code = stdout.match(new RegExp(`::canon-fact::${factId}::(\\d+)`))?.[1];
    if (code === undefined) {
      results[factId] = { held: false, detail: `\`${run}\` did not report a result`, ms: 0 };
      continue;
    }
    if (code === "0") {
      results[factId] = { held: true, detail: "ok", ms: 0 };
      continue;
    }
    const out = stdout.split(`::canon-out::${factId}::begin`)[1]?.split(`::canon-out::${factId}::end`)[0] ?? "";
    results[factId] = { held: false, detail: commandFailure(run, new Error(out)), ms: 0 };
  }
  return results;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// The CI library reports a command's own failure as "<name> failed with exit code N".
export function exitedNonZero(err: unknown): boolean {
  const text = outputOf(err);
  return /failed with exit code \d+/.test(text);
}

// The useful part of a failed command for a verdict: the first "file:line:col rule" location if the
// tool printed one (lint and type errors do), plus its summary line; otherwise its last output lines.
export function commandFailure(run: string, err: unknown): string {
  const raw = outputOf(err).replace(/\u001b\[[0-9;]*m/g, "");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("===") && !/failed with exit code/.test(l) && !/^[━─│]+$/.test(l));
  const location = lines.find((l) => /^[\w./-]+[:(]\d+[:,]\d+\)?[:\s]/.test(l))?.replace(/\s*(FIXABLE)?\s*[━─]{3,}.*$/, "");
  const summary = lines.find((l) => /^(Found \d+ (errors?|warnings?)|\d+ errors?)/i.test(l));
  const detail = [...new Set([location, summary].filter(Boolean))].join(" · ") || lines.slice(-2).join(" · ");
  return `\`${run}\` failed: ${detail.slice(0, 280) || "non-zero exit"}`;
}

