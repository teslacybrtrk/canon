// Diagnoses: the kind of failure a verdict is, told apart for whoever acts next.
import assert from "node:assert/strict";
import { assertionOf, diagnose } from "../referee/src/diagnosis.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const base = { lost: [], stale: [], claimed: { factId: "f", held: false, detail: "" } };
const none = { reapplied: false, passedBefore: false, sameFailureElsewhere: 0 };

assert.equal(diagnose({ ...base, outcome: "ready" }, none), null);
ok("a Ready verdict has no diagnosis");
assert.equal(diagnose({ ...base, outcome: "error" }, none)?.kind, "infrastructure");
ok("a platform error is infrastructure, never the code");
const broke = { ...base, outcome: "contradicts" as const, lost: [{ factId: "price-is-listed", detail: "step 2: totalCents is 4320, expected 4800" }] };
assert.equal(diagnose(broke, none)?.kind, "implementation");
assert.equal(diagnose(broke, { ...none, reapplied: true, passedBefore: true })?.kind, "combination");
ok("breaking a canon fact is the code; breaking it only after a re-apply of a change that was Ready alone is a combination");
const own = { ...base, outcome: "unproven" as const, claimed: { factId: "f", held: false, detail: "step 1: GET /api/x returned 404, expected 200 (with qty = 3)" } };
assert.equal(diagnose(own, none)?.kind, "implementation");
assert.equal(diagnose(own, { ...none, sameFailureElsewhere: 2 })?.kind, "requirement");
assert.equal(assertionOf("sample 2, step 1: GET /api/x returned 404, expected 200 (with qty = 7)"), "step 1: GET /api/x returned 404, expected 200");
ok("its own fact failing is the code, until independent attempts fail it the same way: then maybe the requirement");
assert.equal(diagnose({ ...own, claimed: { factId: "f", held: false, detail: "it already passes on the commit this attempt forked from, so it can't fail: not a new fact" } }, none)?.kind, "requirement");
ok("a fact that already held before the change doesn't capture it: a requirement problem");
assert.equal(diagnose({ ...broke, heldBack: "its rollback rehearsal unavailable (rollback compatibility couldn't be compared for “no-double-booking”: ...)" }, none)?.kind, "unsupported-check");
assert.equal(diagnose({ ...broke, heldBack: "broke “The market page lists every stall” on its release candidate (a full copy with production’s config): step 1: GET / returned 500" }, none)?.kind, "implementation");
ok("held back for missing compatibility evidence is an unsupported check (the owner adds evidence); held back on existing data is the code");
assert.equal(diagnose({ ...base, outcome: "behind", stale: [{ factId: "g", detail: "built before it existed" }] }, none)?.kind, "combination");
ok("behind a newer canon is a combination the judge re-applies itself");
