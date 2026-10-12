// Build failures: the platform's fault is retried, never counted against the code.
import assert from "node:assert/strict";
import { edgeFailure, platformFailure } from "../referee/src/platform.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
assert.ok(platformFailure("preview failed with exit code 1\n✘ [ERROR] Received a malformed response from the API\n\n  <!DOCTYPE html>"));
assert.ok(platformFailure("npm ERR! network request failed, reason: socket hang up"));
assert.ok(platformFailure("✘ [ERROR] A request to the Cloudflare API failed: 503 Service Unavailable"));
ok("an API error page, a dropped connection or a 5xx is the platform");
assert.ok(!platformFailure("src/index.ts(12,3): error TS2304: Cannot find name 'markt'."));
assert.ok(!platformFailure("✘ [ERROR] Could not resolve \"./missing\""));
assert.ok(!platformFailure("Error: the stall must exist (line 500 of the test)"));
ok("a type error or a missing import is the code");

assert.ok(edgeFailure("step 1: GET / returned 530, expected 200"));
assert.ok(edgeFailure("step 1: GET /api/cart failed: The operation was aborted due to timeout"));
assert.ok(!edgeFailure("step 1: GET / returned 500, expected 200"));
assert.ok(!edgeFailure("step 2: POST /api/reservations returned 201, expected 409"));
ok("a check answered by Cloudflare's edge (52x, 530) or by nobody never reached the app; the app's 500 did");
