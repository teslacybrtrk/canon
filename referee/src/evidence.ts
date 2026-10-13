// Evidence the charter requires, as one of a few explicit states. A gate the charter turns on is non-compensatory:
// only "passed" (or a "not-applicable" the judge established, never a failure it assumed away) lets autopilot land a
// fact. A check that didn't run (the platform failed, it timed out, there's no model to ask) is "unavailable", and
// unavailable is not a pass: autopilot waits and the owner decides, which the acceptance record then names.
import type { Mutation } from "./protocol";
import type { Review } from "./review";

export type EvidenceState = "passed" | "failed" | "unavailable" | "not-applicable" | "not-required" | "pending";
export interface Evidence {
  state: EvidenceState;
  detail: string;
}

const MUTATION_TIMEOUT_MS = 20 * 60_000;
const REVIEW_TIMEOUT_MS = 10 * 60_000;

/** Mutation evidence: did the facts catch enough deliberate breaks of the change, as the charter asks? */
export function mutationEvidence(min: number | undefined, factKind: string | undefined, m: Mutation | null, now: number): Evidence {
  if (typeof min !== "number") return { state: "not-required", detail: "the charter sets no mutation threshold" };
  const want = `the charter wants ${Math.round(min * 100)}%`;
  if (factKind !== "probe") return { state: "unavailable", detail: "deliberate breaks are only judged by probe facts, and this fact's check is a command" };
  if (!m) return { state: "pending", detail: "the judge is testing its checks first (deliberate breaks of its change)" };
  if (m.status === "running") {
    return now - m.at < MUTATION_TIMEOUT_MS
      ? { state: "pending", detail: "the judge is testing its checks first (deliberate breaks of its change)" }
      : { state: "unavailable", detail: "the mutation run didn't finish in 20 minutes" };
  }
  if (m.status === "none") {
    if (m.reason === "no-source") return { state: "not-applicable", detail: "the change touches no source file (src/*.ts, *.js), so there is nothing to break" };
    if (m.reason === "no-mutants") return { state: "not-applicable", detail: "none of the lines it adds has an operator, guard or status the mutator can break" };
    return { state: "unavailable", detail: m.reason === "start-failed" ? "the mutation run couldn't start" : "the mutants couldn't be built (platform)" };
  }
  if (m.total === 0) return { state: "unavailable", detail: `none of the ${m.mutants.length} deliberate breaks built or could be checked` };
  const score = `its facts caught ${m.caught} of ${m.total} deliberate breaks of its change`;
  return m.caught / m.total < min ? { state: "failed", detail: `${score}, and ${want}` } : { state: "passed", detail: `${score} (${want})` };
}

/** Review evidence: a reviewer that didn't write the change read it and named no risk, as the charter asks. */
export function reviewEvidence(required: boolean | undefined, hasModel: boolean, r: Review | null, now: number): Evidence {
  if (!required) return { state: "not-required", detail: "the charter doesn't route the reviewer's risks to the owner" };
  if (!hasModel) return { state: "unavailable", detail: "no reviewer model is bound to this judge" };
  if (!r) return { state: "pending", detail: "the reviewer is reading the change first (the charter routes its risks to the owner)" };
  if (r.status === "running") {
    return now - r.at < REVIEW_TIMEOUT_MS
      ? { state: "pending", detail: "the reviewer is reading the change first (the charter routes its risks to the owner)" }
      : { state: "unavailable", detail: "the review didn't finish in 10 minutes" };
  }
  if (r.status === "error") return { state: "unavailable", detail: `the review failed: ${(r.detail ?? "no detail").slice(0, 120)}` };
  if (r.status === "none") return { state: "not-applicable", detail: r.detail ?? "no source files changed" };
  const risk = r.notes.find((n) => n.kind === "risk");
  return risk
    ? { state: "failed", detail: `the reviewer flagged a risk at ${risk.file}:${risk.line} (${risk.note.slice(0, 120)})` }
    : { state: "passed", detail: `the reviewer (${r.model.split("/").pop()}) named no risk${r.notes.length ? ` (${r.notes.length} other note${r.notes.length > 1 ? "s" : ""})` : ""}` };
}

/** What a required piece of evidence means for autopilot: land, wait for it, or leave it to the owner. */
export function gate(kind: string, e: Evidence): { ok: true; note?: string } | { ok: false; wait: string } {
  switch (e.state) {
    case "passed":
      return { ok: true, note: e.detail };
    case "not-required":
      return { ok: true };
    case "not-applicable":
      return { ok: true, note: `${kind} not applicable: ${e.detail}` };
    case "pending":
      return { ok: false, wait: e.detail };
    case "failed":
      return { ok: false, wait: `${e.detail}, so the owner decides` };
    case "unavailable":
      return { ok: false, wait: `the charter requires ${kind} evidence and it's unavailable (${e.detail}); a check that didn't run isn't a pass, so the owner decides` };
  }
}

// ---- Data changes: a previous Worker version is not a database rollback --------------------------------------------

// Schema changes that destroy or reshape stored data: rolling the Worker back doesn't bring it back. (Ordinary writes,
// a DELETE included, are the app's behaviour, which facts judge.)
const DESTRUCTIVE = [
  /\bDROP\s+(?:TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i,
  /\bALTER\s+TABLE\s+[\w"`[\]]+\s+(?:DROP|RENAME)\b/i,
  /\bTRUNCATE\b/i,
  /"(?:deleted_classes|renamed_classes|transferred_classes)"\s*:/, // Durable Object migrations that drop or move data
];
// Lines that only add: the old code ignores a new table or column, so rolling back stays safe (expand, then contract).
const ADDITIVE = [/\bCREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\b/i, /\bALTER\s+TABLE\s+[\w"`[\]]+\s+ADD\b/i, /"new_(?:sqlite_)?classes"\s*:/];

export interface DataChanges {
  destructive: string[]; // "src/index.ts: DROP TABLE carts"
  additive: string[];
}

/** The stored-data changes in the lines a commit adds, by file. A line heuristic: it routes to a person, never decides. */
export function dataChanges(added: Array<{ path: string; lines: string[] }>): DataChanges {
  const out: DataChanges = { destructive: [], additive: [] };
  for (const { path, lines } of added) {
    if (!/\.(?:ts|js|mjs|sql|jsonc?|toml)$/.test(path)) continue;
    for (const line of lines) {
      const text = `${path}: ${line.trim().slice(0, 100)}`;
      if (DESTRUCTIVE.some((re) => re.test(line))) out.destructive.push(text);
      else if (ADDITIVE.some((re) => re.test(line))) out.additive.push(text);
    }
  }
  return out;
}

/** How a release of this change recovers, given its data changes. */
export function recoveryFor(d: DataChanges | undefined): { rollbackSafe: boolean; how: string } {
  if (d?.destructive.length) return { rollbackSafe: false, how: `destructive data change (${d.destructive[0]}): an earlier Worker version restores the code, not the data, so a failed release is not rolled back automatically` };
  if (d?.additive.length) return { rollbackSafe: true, how: `additive data change only (${d.additive[0]}): the earlier version ignores what it added, so rolling back is safe` };
  return { rollbackSafe: true, how: "no stored-data change: rolling back the Worker version restores the behaviour" };
}

/** A short, stable name for a policy (the charter as stored), so an acceptance record says which one allowed it. */
export function policyVersion(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}
