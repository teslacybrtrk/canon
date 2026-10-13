// Required evidence as explicit states: a check that didn't run is never a pass, and "nothing to check" is said out loud.
import assert from "node:assert/strict";
import { dataChanges, dataEvidence, dataFiles, gate, mutationEvidence, policyVersion, recoveryFor, reviewEvidence } from "../referee/src/evidence.ts";
import type { Mutation } from "../referee/src/protocol.ts";
import type { Review } from "../referee/src/review.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const now = Date.parse("2026-10-13T12:00:00Z");
const run = (m: Partial<Mutation>): Mutation => ({ status: "done", total: 0, caught: 0, mutants: [], at: now, ...m });
const mutant = { file: "src/index.ts", line: 3, op: "409 → 200", before: "", after: "" };

assert.equal(mutationEvidence(undefined, "probe", null, now).state, "not-required");
ok("no mutation threshold: not required");
assert.equal(mutationEvidence(0.8, "probe", null, now).state, "pending");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "running" }), now).state, "pending");
ok("a run that hasn't started or finished is pending");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "running", at: now - 21 * 60_000 }), now).state, "unavailable");
ok("a run that never finished is unavailable, not a pass");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "none", reason: "build-failed" }), now).state, "unavailable");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "none", reason: "start-failed" }), now).state, "unavailable");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "none" }), now).state, "unavailable");
ok("no mutants because the platform failed (or no reason given) is unavailable");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "done", total: 0, mutants: [{ ...mutant, caught: null }] }), now).state, "unavailable");
ok("mutants that didn't build or couldn't be checked are unavailable, not a 100% score");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "none", reason: "no-source" }), now).state, "not-applicable");
assert.equal(mutationEvidence(0.8, "probe", run({ status: "none", reason: "no-mutants" }), now).state, "not-applicable");
ok("nothing to break is an explicit not-applicable");
assert.equal(mutationEvidence(0.8, "command", null, now).state, "unavailable");
ok("a command fact can't be mutation-tested: unavailable (the owner decides), not a silent pass or an endless wait");
assert.equal(mutationEvidence(0.8, "probe", run({ total: 5, caught: 3, mutants: Array(5).fill({ ...mutant, caught: true }) }), now).state, "failed");
assert.equal(mutationEvidence(0.8, "probe", run({ total: 5, caught: 4, mutants: Array(5).fill({ ...mutant, caught: true }) }), now).state, "passed");
ok("a score below the threshold fails; at or above passes");

const review = (r: Partial<Review>): Review => ({ status: "done", model: "@cf/moonshotai/kimi-k2.7-code", notes: [], dropped: 0, at: now, ...r });
assert.equal(reviewEvidence(false, true, null, now).state, "not-required");
assert.equal(reviewEvidence(true, false, null, now).state, "unavailable");
ok("a required review with no model to ask is unavailable (it used to skip the gate)");
assert.equal(reviewEvidence(true, true, review({ status: "error", detail: "every reviewer model was out of capacity" }), now).state, "unavailable");
assert.equal(reviewEvidence(true, true, review({ status: "running", at: now - 11 * 60_000 }), now).state, "unavailable");
ok("a review that failed or never finished is unavailable (it used to pass)");
assert.equal(reviewEvidence(true, true, review({ status: "none", detail: "no source files changed" }), now).state, "not-applicable");
assert.equal(reviewEvidence(true, true, review({ notes: [{ file: "src/index.ts", line: 9, quote: "x", kind: "risk", note: "two writes, no transaction" }] }), now).state, "failed");
assert.equal(reviewEvidence(true, true, review({ notes: [{ file: "src/index.ts", line: 9, quote: "x", kind: "untested", note: "no fact covers this" }] }), now).state, "passed");
ok("a named risk fails the review; other notes don't");

assert.deepEqual(gate("mutation", { state: "passed", detail: "caught 4 of 5" }), { ok: true, note: "caught 4 of 5" });
assert.equal(gate("review", { state: "not-required", detail: "" }).ok, true);
assert.match((gate("mutation", { state: "not-applicable", detail: "nothing to break" }) as { note: string }).note, /not applicable: nothing to break/);
for (const state of ["failed", "unavailable", "pending"] as const) assert.equal(gate("mutation", { state, detail: "x" }).ok, false);
assert.match((gate("review", { state: "unavailable", detail: "timed out" }) as { wait: string }).wait, /isn't a pass, so the owner decides/);
ok("only passed, not-required and not-applicable let autopilot land; the rest wait");

const d = dataChanges([
  { path: "src/index.ts", lines: ['    this.sql.exec("ALTER TABLE carts DROP COLUMN note");', '    this.sql.exec("CREATE TABLE IF NOT EXISTS reservations (id INTEGER)");', '    this.sql.exec("DELETE FROM carts WHERE id = ?", id);'] },
  { path: "wrangler.jsonc", lines: ['      "deleted_classes": ["Cart"]', '      "new_sqlite_classes": ["Market"]'] },
]);
assert.equal(d.destructive.length, 2);
assert.match(d.destructive[0], /^src\/index.ts: .*DROP COLUMN/);
assert.match(d.destructive[1], /^wrangler.jsonc: .*deleted_classes/);
assert.equal(d.additive.length, 2);
assert.equal(d.writes.length, 1); // the DELETE ... WHERE: a write, not a schema change
ok("schema changes: DROP and deleted Durable Object classes are destructive, CREATE and new classes additive, writes listed");
assert.deepEqual(dataFiles(["src/index.ts", "src/view.tsx", "migrations/0002.sql", "wrangler.jsonc", "README.md", "package-lock.json", "logo.png"]), ["src/index.ts", "src/view.tsx", "migrations/0002.sql", "wrangler.jsonc"]);
ok("every changed code, SQL or config file is read (TSX included); lockfiles, docs and images aren't");
const dyn = dataChanges([{ path: "src/db.ts", lines: ["  sql.exec(`ALTER TABLE ${table} RENAME COLUMN a TO b`);"] }]);
assert.equal(dyn.destructive.length, 1);
ok("a schema change on an interpolated table name is still caught");

assert.equal(recoveryFor(d).rollbackSafe, false);
assert.equal(recoveryFor(d).rehearse, false);
ok("destructive: not rollback-safe, and a person decides (no rehearsal makes data come back)");
const adds = dataChanges([{ path: "src/index.ts", lines: ['this.sql.exec("CREATE TABLE IF NOT EXISTS reservations (id INTEGER)");'] }]);
assert.deepEqual([recoveryFor(adds).rollbackSafe, recoveryFor(adds).rehearse], [false, true]);
const writes = dataChanges([{ path: "src/index.ts", lines: ["this.sql.exec(`INSERT INTO reservations VALUES (?, ?)`, a, b);"] }]);
assert.deepEqual([recoveryFor(writes).rollbackSafe, recoveryFor(writes).rehearse], [false, true]);
ok("additive schema or writes: rollback-safe only once rehearsed, not assumed");
const none = dataChanges([{ path: "src/index.ts", lines: ["if (qty > 99) return { ok: false };"] }]);
assert.deepEqual([recoveryFor(none).rollbackSafe, recoveryFor(none).rehearse], [false, true]);
ok("nothing recognised as touching data still isn't called safe: patterns can't prove absence, the rehearsal decides");
for (const unknown of [undefined, dataChanges([], false, "couldn't read src/index.ts: timeout")]) {
  assert.deepEqual([recoveryFor(unknown).rollbackSafe, recoveryFor(unknown).rehearse], [false, true]);
  assert.equal(dataEvidence(unknown).state, "unavailable");
}
ok("an inspection that couldn't read everything is unavailable evidence, never \"no data change\"");
assert.equal(dataEvidence(d).state, "failed");
assert.equal(dataEvidence(adds).state, "passed");
assert.equal(dataEvidence(none).state, "passed");
ok("autopilot: destructive waits for a person, not knowing waits too, the rest lands (and rehearses at release)");

assert.equal(policyVersion('{"a":1}'), policyVersion('{"a":1}'));
assert.notEqual(policyVersion('{"a":1}'), policyVersion('{"a":2}'));
assert.match(policyVersion(""), /^[0-9a-f]{8}$/);
ok("a policy version names the exact charter");

// Rollback compatibility: what the rehearsal compared decides what it establishes; missing evidence is never a pass.
{
  const { compatibilityVerdict, storageBindings } = await import("../referee/src/evidence.ts");
  const cov = (over: Partial<Parameters<typeof compatibilityVerdict>[0]>) => ({ compared: [], incompatible: [], inconclusive: [], unsupported: [], notApplicable: [], storage: "storage bindings: durable_objects", ...over });
  assert.equal(compatibilityVerdict(cov({ compared: ["a"], incompatible: [{ id: "profile", detail: "GET /profiles/p1 returned 500" }] }), false).state, "failed");
  ok("old code that reads its own control but not the new fixture: the rehearsal fails, so autopilot holds the release");
  const unsupported = compatibilityVerdict(cov({ compared: ["a"], unsupported: [{ id: "booking", why: "it writes state but has no GET step that reads it back" }] }), false);
  assert.equal(unsupported.state, "unavailable");
  assert.match(unsupported.detail, /Add a GET step/);
  ok("a required comparison that can't be made is unavailable, and says what evidence would establish it");
  assert.equal(compatibilityVerdict(cov({ compared: ["a"], inconclusive: [{ id: "b", why: "the previous version can't read back even what it wrote itself" }] }), false).state, "unavailable");
  ok("a failed control read is inconclusive, never counted as compatibility");
  assert.equal(compatibilityVerdict(cov({ notApplicable: [{ id: "refused", why: "every write is refused" }] }), false).state, "unavailable");
  assert.equal(compatibilityVerdict(cov({ storage: "unknown: no Wrangler config found" }), false).state, "unavailable");
  ok("zero comparisons on an app that keeps data (or might) is unavailable, not a pass");
  const stateless = compatibilityVerdict(cov({ storage: "no storage bindings" }), true);
  assert.equal(stateless.state, "passed");
  assert.match(stateless.detail, /keeps no persistent state/);
  ok("with the stateless basis established, nothing to compare is a pass that names its basis");
  assert.equal(compatibilityVerdict(cov({ compared: ["a", "b"], notApplicable: [{ id: "c", why: "x" }] }), false).state, "passed");
  ok("compatible fixtures pass, with the coverage counted");
  assert.deepEqual(storageBindings('{\n  // a stateless Worker\n  "name": "x"\n}').bindings, []);
  assert.deepEqual(storageBindings('{ "durable_objects": { "bindings": [] } }').bindings, ["durable_objects"]);
  assert.deepEqual(storageBindings('[[d1_databases]]\nbinding = "DB"').bindings, ["d1_databases"]);
  assert.equal(storageBindings(null).known, false);
  ok("storage bindings are read from the Wrangler config (JSON, JSONC or TOML); no config is unknown, never stateless");
}

// No storage bindings is not "no persistent state": an app can write an external database over HTTP. Only an explicit
// owner declaration, with no bindings, lets a rehearsal pass with nothing to compare.
{
  const { statelessBasis, compatibilityVerdict } = await import("../referee/src/evidence.ts");
  const none = { known: true, bindings: [] as string[] };
  const external = statelessBasis(none, false);
  assert.equal(external.stateless, false);
  const cov = { compared: [], incompatible: [], inconclusive: [], unsupported: [], notApplicable: [], storage: external.storage };
  const v = compatibilityVerdict(cov, external.stateless);
  assert.equal(v.state, "unavailable");
  assert.match(v.detail, /external database|declared/);
  ok("an app with no storage bindings (that may write an external database over HTTP) gets no zero-comparison pass");
  const declared = statelessBasis(none, true);
  assert.equal(declared.stateless, true);
  const pass = compatibilityVerdict({ ...cov, storage: declared.storage }, true);
  assert.equal(pass.state, "passed");
  assert.match(pass.detail, /owner's declaration/);
  ok("an app its owner declares stateless (and with no bindings) keeps the lightweight path, and the record names the declaration as its basis");
  assert.equal(statelessBasis({ known: true, bindings: ["d1_databases"] }, true).stateless, false);
  assert.equal(statelessBasis({ known: false, bindings: [] }, true).stateless, false);
  ok("a declaration never overrides storage bindings in the config, or an unreadable config");
}
