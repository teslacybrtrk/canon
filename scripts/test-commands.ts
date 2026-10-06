// Command facts in one container: the generated script, run for real in bash, and its parsed results.
//   node scripts/test-commands.ts
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFailure, commandScript, exitedNonZero, heldOnBase, parseCommandResults } from "../referee/src/commands.ts";

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

// A claimed command fact also runs on the commit the attempt forked from, rebuilt from the attempt's checkout.
// Here the attempt removed a TODO from src/index.ts, added src/new.ts and deleted src/old.ts.
const ws = mkdtempSync(join(tmpdir(), "canon-ws-"));
mkdirSync(join(ws, "src"));
mkdirSync(join(ws, "node_modules"));
writeFileSync(join(ws, "src/index.ts"), "export const a = 1;\n");
writeFileSync(join(ws, "src/new.ts"), "export const b = 2;\n");
writeFileSync(join(ws, "node_modules/tool.sh"), "exit 0\n");
const b64 = (text: string) => Buffer.from(text).toString("base64");
const claimed = { factId: "no-todos", run: "! grep -rn TODO src && test ! -e src/new.ts && test -e src/old.ts && sh node_modules/tool.sh" };
const run = (baseIndex: string) => {
  const base = { factId: claimed.factId, run: claimed.run, files: [
    { path: "src/index.ts", b64: b64(baseIndex) }, { path: "src/new.ts", b64: null }, { path: "src/old.ts", b64: b64("old\n") },
  ] };
  const out = execSync(commandScript([{ factId: "no-todos", run: "! grep -rn TODO src" }], base), { encoding: "utf8", shell: "/bin/bash", cwd: ws });
  return { head: parseCommandResults([{ factId: "no-todos", run: "" }], out)["no-todos"].held, base: heldOnBase(base, out) };
};
let res = run("export const a = 1; // TODO\n");
assert.deepEqual(res, { head: true, base: false });
assert.equal(readFileSync(join(ws, "src/index.ts"), "utf8"), "export const a = 1;\n");
assert.ok(existsSync(join(ws, "src/new.ts")) && !existsSync(join(ws, "src/old.ts")));
console.log("ok  fails on the forked-from commit -> a new fact; the attempt's own checkout is untouched");
res = run("export const a = 1;\n");
assert.deepEqual(res, { head: true, base: true });
console.log("ok  passes on the forked-from commit too -> not a new fact (added files gone, deleted ones back, node_modules shared)");
