// The canary's verdict: the new version is blamed only for failures the old one didn't have at the same moment.
import assert from "node:assert/strict";
import { canaryVerdict } from "../referee/src/telemetry.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
assert.equal(canaryVerdict({ newFails: 0, oldFails: 0 }).bad, false);
assert.equal(canaryVerdict({ newFails: 1, oldFails: 0 }).bad, false);
ok("no failures, or one isolated failure: the rollout goes on");
assert.equal(canaryVerdict({ newFails: 3, oldFails: 0 }).bad, true);
ok("the new version failing checks the old one passed at the same moment stops the rollout");
assert.equal(canaryVerdict({ newFails: 3, oldFails: 4 }).bad, false);
ok("both versions failing as much (the network, a shared dependency) isn't the new version's fault");
assert.equal(canaryVerdict({ newFails: 0, oldFails: 0, analytics: { newRate: 0.08, oldRate: 0.01, newRequests: 200 } }).bad, true);
assert.equal(canaryVerdict({ newFails: 0, oldFails: 0, analytics: { newRate: 0.5, oldRate: 0, newRequests: 4 } }).bad, false);
ok("real traffic: a clearly higher error rate on enough requests stops it; four requests aren't enough to tell");
assert.equal(canaryVerdict({ newFails: 0, oldFails: 0, raw: { newErrors: 13, oldErrors: 0, each: 40 } }).bad, true);
assert.equal(canaryVerdict({ newFails: 0, oldFails: 0, raw: { newErrors: 2, oldErrors: 1, each: 40 } }).bad, false);
ok("raw requests with no retries catch a one-in-three error rate the checks' retries would hide; noise doesn't");
