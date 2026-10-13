// The release fence: a stalled or superseded release run can't take another step that changes a Worker.
import assert from "node:assert/strict";
import { deploymentOwner, holdsLease, JUDGE_WRITE_MS, leaseDecision, RELEASE_LEASE_MS, RELEASE_START_MS, UNKNOWN_WRITE_QUARANTINE_MS, writeBarrier, type Lease } from "../referee/src/release.ts";

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

// Production's deployment has one owner at a time, and every write outside a release run asks deploymentOwner first.
const republish: Lease = { seq: 5, sha: "abc", holder: "promote-5-abc-r1x", until: now + RELEASE_LEASE_MS };
assert.match(deploymentOwner(republish, null, now) ?? "", /republish of canon #5/);
ok("a republish of a released canon owns production while its lease is live (no pending canon row needed): reconciliation doesn't write");
assert.match(deploymentOwner(null, { seq: 6, at: now - 1_000 }, now) ?? "", /canon #6's release, starting/);
ok("a release accepted while reconciliation was listing deployments owns production before its run starts: the POST is refused");
assert.match(deploymentOwner(held("run-a"), { seq: 5, at: now - 60_000 }, now) ?? "", /release of canon #5/);
ok("background rollback and restore respect an active release's lease");
assert.equal(deploymentOwner({ ...republish, until: now - 1 }, null, now), null);
assert.equal(deploymentOwner({ ...republish, ended: "released" }, null, now), null);
assert.equal(deploymentOwner(held("run-a", now - 1), { seq: 5, at: now - 60_000 }, now), null);
assert.equal(deploymentOwner(null, { seq: 6, at: now - RELEASE_START_MS - 1 }, now), null);
ok("expired or ended ownership (and a release that never started) lets the judge reconcile");
assert.equal(holdsLease({ ...held("run-old"), ended: "superseded" }, 5, "run-old", now), false);
assert.equal(holdsLease(held("run-new"), 5, "run-old", now), false);
ok("a stale run that lost the lease holds nothing, so its captured version is never written over the new owner's");

// The production-write barrier: a release or republish write (the gate's, or a direct deploy's fence) waits until no
// judge write can still land. Answered: lifted. Timed out or lost: it may still land remotely, so it's held.
assert.equal(writeBarrier("sending", now), now + JUDGE_WRITE_MS + UNKNOWN_WRITE_QUARANTINE_MS);
ok("armed for the whole window before the judge's request goes out (an eviction mid-write leaves it armed)");
assert.equal(writeBarrier("answered", now), 0);
ok("lifted as soon as the deployments API answers: the write's outcome is known");
assert.equal(writeBarrier("unknown", now + 20_000), now + 20_000 + UNKNOWN_WRITE_QUARANTINE_MS);
ok("a client timeout is not a cancelled write: the barrier holds for a quarantine after it");
