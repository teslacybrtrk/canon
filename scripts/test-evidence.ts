// Required evidence as explicit states: a check that didn't run is never a pass, and "nothing to check" is said out loud.
import assert from "node:assert/strict";
import { dataChanges, gate, mutationEvidence, policyVersion, recoveryFor, reviewEvidence } from "../referee/src/evidence.ts";
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
  { path: "README.md", lines: ["DROP TABLE is dangerous"] },
]);
assert.equal(d.destructive.length, 2);
assert.match(d.destructive[0], /^src\/index.ts: .*DROP COLUMN/);
assert.match(d.destructive[1], /^wrangler.jsonc: .*deleted_classes/);
assert.equal(d.additive.length, 2);
ok("schema changes: DROP and deleted Durable Object classes are destructive, CREATE and new classes additive; DELETE rows and docs aren't schema");
assert.equal(recoveryFor(d).rollbackSafe, false);
assert.equal(recoveryFor({ destructive: [], additive: d.additive }).rollbackSafe, true);
assert.equal(recoveryFor(undefined).rollbackSafe, true);
ok("rolling back is safe unless a schema change destroyed data");

assert.equal(policyVersion('{"a":1}'), policyVersion('{"a":1}'));
assert.notEqual(policyVersion('{"a":1}'), policyVersion('{"a":2}'));
assert.match(policyVersion(""), /^[0-9a-f]{8}$/);
ok("a policy version names the exact charter");
