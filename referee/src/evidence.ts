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
export function reviewEvidence(required: boolean | undefined, hasModel: boolean, r: Review | null, now: number, intentCounts = false): Evidence {
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
  if (r.coverage && r.coverage.reviewed < r.coverage.files) return { state: "unavailable", detail: `the review covered ${r.coverage.reviewed} of ${r.coverage.files} changed source files${r.coverage.omitted?.length ? ` (${r.coverage.omitted.join(", ")} changed too much to show, even around each change)` : ""}` };
  const risk = r.notes.find((n) => n.kind === "risk") ?? (intentCounts ? r.notes.find((n) => n.kind === "intent") : undefined);
  if (risk) return { state: "failed", detail: `the reviewer flagged ${risk.kind === "intent" ? "something its fact doesn't ask for" : "a risk"} at ${risk.file}:${risk.line} (${risk.note.slice(0, 120)})` };
  // A finding the reviewer couldn't tie to a line of the change is unconfirmed, not resolved: the review isn't clean.
  const open = (r.unresolved ?? []).find((u) => u.kind === "risk" || (intentCounts && u.kind === "intent"));
  if (open) return { state: "unavailable", detail: `the reviewer named ${open.kind === "intent" ? "something the change does that its fact doesn't ask for" : "a risk"} but quoted nothing that is in the change (${open.note.slice(0, 120)}); unconfirmed isn't clean` };
  return { state: "passed", detail: `the reviewer (${r.model.split("/").pop()}) named no risk${r.notes.length ? ` (${r.notes.length} other note${r.notes.length > 1 ? "s" : ""})` : ""}` };
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
  // What the rehearsal compared, fact by fact (see compatibilityVerdict).
  coverage?: CompatibilityCoverage;
  // A release that went out although its rollback wasn't shown safe, on a person's authority: who, and over what.
  override?: string;
}

// ---- Rollback compatibility: what the rehearsal compared, and what that establishes ----------------------------------
//
// Each stateful fact that was canon before the release is one comparison: its fixture written by this release's code,
// then read (GET steps only) by the previous code, beside a control fixture the previous code wrote itself. A fact is
// compared (old code reads both), incompatible (it reads its own but not the new one), inconclusive (a fixture couldn't
// be written, or old code can't read even its own), unsupported (it writes state and has no read step), or not
// applicable (it leaves no state). Missing evidence is never a pass: unsupported or inconclusive is unavailable, and so
// is a rehearsal that compared nothing, unless the app demonstrably keeps no data (no storage bindings in its config).

export interface CompatibilityCoverage {
  compared: string[];
  incompatible: Array<{ id: string; detail: string }>;
  inconclusive: Array<{ id: string; why: string }>;
  unsupported: Array<{ id: string; why: string }>;
  notApplicable: Array<{ id: string; why: string }>;
  storage: string; // what the app's config says about stored data ("bindings: durable_objects", "no storage bindings", "unknown: ...")
}

/**
 * Whether a rehearsal may pass with nothing to compare: only when the app's config has no storage bindings AND its
 * owner declares (canon.json policy "state": "none") that it keeps no state elsewhere either, such as an external
 * database over HTTP, which no config shows. Either alone leaves statefulness unknown.
 */
export function statelessBasis(storage: { known: boolean; bindings: string[] }, declared: boolean): { stateless: boolean; storage: string } {
  const config = !storage.known ? "unknown: no Wrangler config found" : storage.bindings.length ? `storage bindings: ${storage.bindings.join(", ")}` : "no storage bindings";
  if (storage.known && !storage.bindings.length && declared) return { stateless: true, storage: `${config}, and the owner declares no persistent state elsewhere (policy "state": "none")` };
  if (storage.known && !storage.bindings.length) return { stateless: false, storage: `${config}, but the app may keep state elsewhere (an external database over HTTP); the owner hasn't declared "state": "none"` };
  return { stateless: false, storage: config };
}

export function compatibilityVerdict(c: CompatibilityCoverage, stateless: boolean): { state: "passed" | "failed" | "unavailable"; detail: string } {
  const counts = `${c.compared.length} compared, ${c.incompatible.length} incompatible, ${c.inconclusive.length} inconclusive, ${c.unsupported.length} unsupported, ${c.notApplicable.length} not applicable`;
  if (c.incompatible.length) {
    const x = c.incompatible[0];
    return { state: "failed", detail: `the previous version can't read what this release wrote for “${x.id}” (it reads what it wrote itself): ${x.detail} [${counts}]` };
  }
  if (c.unsupported.length) {
    const x = c.unsupported[0];
    return { state: "unavailable", detail: `rollback compatibility couldn't be compared for “${x.id}”: ${x.why}. Add a GET step that reads back what it writes, or declare "fixture": "none" if it leaves nothing to read [${counts}]` };
  }
  if (c.inconclusive.length) {
    const x = c.inconclusive[0];
    return { state: "unavailable", detail: `rollback compatibility was inconclusive for “${x.id}”: ${x.why} [${counts}]` };
  }
  if (!c.compared.length) {
    return stateless
      ? { state: "passed", detail: `nothing to compare, on the owner's declaration that the app keeps no persistent state (${c.storage}) [${counts}]` }
      : { state: "unavailable", detail: `no fact read back what this release wrote, so compatibility with stored data is unknown (${c.storage}); a stateful fact with a GET step would establish it [${counts}]` };
  }
  return { state: "passed", detail: `the previous version read back what this release wrote in every comparison [${counts}]` };
}

/** Storage bindings in a Wrangler config (JSON, JSONC or TOML text). null config: unknown, which is never "stateless". */
export function storageBindings(config: string | null): { known: boolean; bindings: string[] } {
  if (config === null) return { known: false, bindings: [] };
  const kinds = ["durable_objects", "d1_databases", "kv_namespaces", "r2_buckets", "hyperdrive", "vectorize", "queues", "workflows"];
  const text = config.replace(/^\s*(\/\/|#).*$/gm, "");
  return { known: true, bindings: kinds.filter((k) => new RegExp(`(^|[^\\w])${k}([^\\w]|$)`, "m").test(text)) };
}

/** How a release of this change recovers, given what the judge found (undefined: it couldn't look at all). */
export function recoveryFor(d: DataChanges | undefined): Recovery {
  if (!d || !d.complete) return { rollbackSafe: false, rehearse: true, how: `the judge couldn't read every changed file (${d?.why ?? "it couldn't inspect the change"}), so rollback isn't known to be safe until it is rehearsed` };
  if (d.destructive.length) return { rollbackSafe: false, rehearse: false, how: `destructive data change (${d.destructive[0]}): an earlier Worker version restores the code, not the data, so a failed release is not rolled back automatically` };
  const touch = d.additive[0] ?? d.writes[0];
  if (touch) return { rollbackSafe: false, rehearse: true, how: `it touches stored data (${touch}): rollback is safe only once rehearsed, the previous version run on data this one wrote` };
  // Patterns can't prove a change leaves stored data alone (a new value passed to an old helper changes what's stored):
  // classification only decides what evidence is needed, and rollback safety always comes from the rehearsal.
  return { rollbackSafe: false, rehearse: true, how: `no added line was recognised as touching stored data (${d.files ?? 0} changed file${d.files === 1 ? "" : "s"} read), but recognition can't prove that: rollback is safe once rehearsed` };
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
