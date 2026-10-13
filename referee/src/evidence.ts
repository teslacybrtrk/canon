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
//
// Three questions, kept apart: did the judge read every changed file (complete)? Do the added lines destroy stored data
// (destructive: only a person accepts that)? Do they touch stored data at all (additive schema or writes)? Not finding
// anything is never the same as "safe": an incomplete inspection is unavailable evidence, and a change that touches
// stored data is rollback-safe only once the rollback is rehearsed (the previous version run on data this one wrote).
// The line patterns are a heuristic that routes and rehearses; they never decide that a change is good.

const TABLE = String.raw`(?:[\w"\x60[\].]+|\$\{[^}]+\})`; // a table name, or an interpolated one
// Schema changes that destroy or reshape stored data: rolling the Worker back doesn't bring it back.
const DESTRUCTIVE = [
  /\bDROP\s+(?:TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i,
  new RegExp(String.raw`\bALTER\s+TABLE\s+${TABLE}\s+(?:DROP|RENAME)\b`, "i"),
  /\bTRUNCATE\b/i,
  /"(?:deleted_classes|renamed_classes|transferred_classes)"\s*:/, // Durable Object migrations that drop or move data
];
// Schema that only adds: the old code ignores a new table or column (expand, then contract).
const ADDITIVE = [/\bCREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)\b/i, new RegExp(String.raw`\bALTER\s+TABLE\s+${TABLE}\s+ADD\b`, "i"), /"new_(?:sqlite_)?classes"\s*:/];
// Writes to stored data: what the old version will find if production rolls back.
const WRITES = [
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i,
  /\bstorage\.(?:put|delete|deleteAll|transaction|transactionSync)\s*\(/, // Durable Object storage
  /\benv\.[A-Z][A-Z0-9_]*\.(?:put|delete)\s*\(/, // KV and R2 bindings
];
// Files whose added lines are read; anything else that changed is listed as not inspected.
export const INSPECTED = /\.(?:[cm]?[jt]sx?|sql|jsonc?|toml)$/;
const IGNORED = /(?:^|\/)(?:package-lock\.json|node_modules\/|dist\/)/;

export interface DataChanges {
  complete: boolean; // every changed file that could hold data code was read
  why?: string; // what couldn't be read, when not complete
  files?: number; // how many changed files were read
  destructive: string[]; // "src/index.ts: DROP TABLE carts"
  additive: string[];
  writes: string[];
}

/** Which changed files to read for data changes (lockfiles and build output aside). */
export function dataFiles(changed: string[]): string[] {
  return changed.filter((p) => INSPECTED.test(p) && !IGNORED.test(p));
}

/** The stored-data changes in the lines a commit adds, by file, for the files read. Completeness is the caller's. */
export function dataChanges(added: Array<{ path: string; lines: string[] }>, complete = true, why?: string): DataChanges {
  const out: DataChanges = { complete, ...(why ? { why } : {}), files: added.length, destructive: [], additive: [], writes: [] };
  for (const { path, lines } of added) {
    for (const line of lines) {
      const text = `${path}: ${line.trim().slice(0, 100)}`;
      if (DESTRUCTIVE.some((re) => re.test(line))) out.destructive.push(text);
      else if (ADDITIVE.some((re) => re.test(line))) out.additive.push(text);
      else if (WRITES.some((re) => re.test(line))) out.writes.push(text);
    }
  }
  return out;
}

export interface Recovery {
  rollbackSafe: boolean; // known safe: a failed release may be rolled back automatically
  rehearse: boolean; // the release rehearses the rollback before production (the previous version on this one's data)
  how: string;
  rehearsal?: Evidence & { at: number }; // the rehearsal's result, once it ran
  // When a release that touched stored data didn't ship: the release candidate rebuilt from production's code, so its
  // data never keeps a shape production didn't have.
  candidateReset?: { ok: boolean; detail: string; at: number };
}

/** How a release of this change recovers, given what the judge found (undefined: it couldn't look at all). */
export function recoveryFor(d: DataChanges | undefined): Recovery {
  if (!d || !d.complete) return { rollbackSafe: false, rehearse: true, how: `the judge couldn't read every changed file (${d?.why ?? "it couldn't inspect the change"}), so rollback isn't known to be safe until it is rehearsed` };
  if (d.destructive.length) return { rollbackSafe: false, rehearse: false, how: `destructive data change (${d.destructive[0]}): an earlier Worker version restores the code, not the data, so a failed release is not rolled back automatically` };
  const touch = d.additive[0] ?? d.writes[0];
  if (touch) return { rollbackSafe: false, rehearse: true, how: `it touches stored data (${touch}): rollback is safe only once rehearsed, the previous version run on data this one wrote` };
  return { rollbackSafe: true, rehearse: false, how: `no added line changes schema or writes stored data (${d.files ?? 0} changed file${d.files === 1 ? "" : "s"} read): rolling back the Worker restores the behaviour` };
}

/** The data evidence autopilot needs: destructive waits for a person; not knowing waits too; the rest lands. */
export function dataEvidence(d: DataChanges | undefined): Evidence {
  if (!d) return { state: "unavailable", detail: "the judge couldn't inspect which files the commit changed" };
  if (!d.complete) return { state: "unavailable", detail: `the judge couldn't read every changed file (${d.why})` };
  if (d.destructive.length) return { state: "failed", detail: `it changes stored data destructively (${d.destructive[0]}), and rolling the Worker back wouldn't bring the data back` };
  return { state: "passed", detail: recoveryFor(d).how };
}

/** A rollback rehearsal's outcome, as evidence for the release. */
export function rehearsalEvidence(ran: "passed" | "failed" | "unavailable", detail: string, at: number): Evidence & { at: number } {
  return { state: ran, detail, at };
}

/** A short, stable name for a policy (the charter as stored), so an acceptance record says which one allowed it. */
export function policyVersion(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}
