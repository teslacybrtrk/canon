// Command facts in one container: the generated script, run for real in bash, and its parsed results.
//   node scripts/test-commands.ts
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { commandFailure, commandScript, exitedNonZero, parseCommandResults } from "../referee/src/commands.ts";

const commands = [
  { factId: "passes", run: "echo all good" },
  { factId: "fails", run: "echo 'src/index.ts:96:5 lint/suspicious/noConsole  FIXABLE  ━━━━' && echo 'Found 1 error.' && exit 1" },
  { factId: "quoted", run: "printf '%s  %s\\n' a b | grep -q 'a  b' && echo \"quotes ok\"" },
];
const stdout = execSync(commandScript(commands), { encoding: "utf8", shell: "/bin/bash" });
const r = parseCommandResults(commands, stdout);
assert.equal(r.passes.held, true);
assert.equal(r.quoted.held, true, "single quotes, double quotes and %s survive the trip");
assert.equal(r.fails.held, false);
assert.match(r.fails.detail, /src\/index\.ts:96:5 lint\/suspicious\/noConsole · Found 1 error\./);
console.log(`ok  one container, three facts: ${Object.entries(r).map(([k, v]) => `${k}=${v.held ? "holds" : "fails"}`).join(", ")}`);
console.log(`ok  failure detail: ${r.fails.detail}`);

assert.equal(exitedNonZero(new Error("install failed with exit code 1\n=== stdout ===")), true);
assert.equal(exitedNonZero(new Error("RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable")), false);
assert.equal(exitedNonZero(new Error("WorkflowInternalError: Attempt failed due to internal workflows error")), false);
console.log("ok  exit-code failures are verdicts; 503s and Workflows errors are platform errors");
assert.match(commandFailure("npx tsc", new Error("src/a.ts(4,2): error TS2322: nope")), /error TS2322/);
