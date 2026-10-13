// The release fence: a stalled or superseded release run can't take another step that changes a Worker.
import assert from "node:assert/strict";
import { holdsLease, leaseDecision, RELEASE_LEASE_MS, type Lease } from "../referee/src/release.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const now = 1_000_000;
const held = (holder: string, until = now + RELEASE_LEASE_MS, ended?: string): Lease => ({ seq: 5, sha: "abc", holder, until, ...(ended ? { ended } : {}) });

assert.deepEqual(leaseDecision(null, 5, "run-a", now), { go: true });
assert.deepEqual(leaseDecision(held("run-x", now + 1, undefined), 6, "run-a", now), { go: true });
ok("the first run to ask takes the release (an older canon's lease doesn't matter)");
assert.deepEqual(leaseDecision(held("run-a"), 5, "run-a", now), { go: true });
ok("the holder renews its lease before each step");
assert.equal(leaseDecision(held("run-b"), 5, "run-a", now).go, false);
ok("a second run is refused while the first holds the release");
assert.equal(leaseDecision(held("run-a", now - 1), 5, "run-a", now).go, false);
assert.equal(holdsLease(held("run-a", now - 1), 5, "run-a", now), false);
ok("a run that stalled past its lease is fenced out, and its reports are ignored");
assert.equal(leaseDecision(held("run-a", now + 60_000, "its run stalled past its lease"), 5, "run-a", now).go, false);
ok("once the judge settles a release, its run can't resume it");
assert.deepEqual(leaseDecision(held("run-b", now - 1), 5, "run-r1", now), { go: true });
assert.deepEqual(leaseDecision(held("run-b", now + 60_000, "released"), 5, "run-r1", now), { go: true });
ok("after a run's lease runs out or its release settles, a new run (a republish) may take it");
assert.equal(holdsLease(held("run-a"), 5, "run-a", now), true);
assert.equal(holdsLease(held("run-a"), 5, "run-b", now), false);
ok("only the current holder's reports count");
