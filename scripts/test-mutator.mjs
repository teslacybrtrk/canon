// The mutant generator the judge runs in CI (MUTATOR_JS in referee/src/pipelines.ts): it must find the lines an attempt
// added, break them in the expected ways, and put every file back exactly.
//   node scripts/test-mutator.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("../referee/src/pipelines.ts", import.meta.url), "utf8");
const js = src.match(/const MUTATOR_JS = String\.raw`([\s\S]*?)`;/)?.[1];
if (!js) throw new Error("MUTATOR_JS not found in pipelines.ts");
const dir = mkdtempSync(join(tmpdir(), "canon-mutator-"));
const mutator = join(dir, "mutator.js");
writeFileSync(mutator, js);
mkdirSync(join(dir, "src"));

const base = ["export function add(qty) {", "  if (qty < 1) return 400;", "  return 200;", "}", ""].join("\n");
const head = [
  "export function add(qty) {",
  "  if (qty < 1) return 400;",
  "  if (qty > 99) return { ok: false, status: 400 };", // a guard: removed
  "  const big = qty >= 100;", // a comparison: flipped
  '  if (big) return Response.json({ error: "too many" }, { status: 409 });', // a guard (removed, not the status)
  "  // a comment is never broken",
  "  return 200;",
  "}",
  "",
].join("\n");
writeFileSync(join(dir, "src/app.ts"), head);
writeFileSync("/tmp/canon-mut-files.json", JSON.stringify([{ path: "src/app.ts", b64: Buffer.from(base).toString("base64") }]));
const run = (...args) => execFileSync("node", [mutator, ...args], { cwd: dir, env: { ...process.env, MAX: "6", PREFIX: "p-" } }).toString().trim();

let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok " : "FAIL"}  ${what}`);
  if (!cond) failed++;
};

const n = Number(run("gen"));
const mutants = JSON.parse(readFileSync("/tmp/canon-mutants.json", "utf8"));
ok(n === 3 && mutants.length === 3, `three mutants from three added lines (got ${n})`);
ok(mutants.every((m) => m.file === "src/app.ts"), "every mutant names its file");
ok(!mutants.some((m) => m.line === 2 || m.line === 7), "lines the attempt didn't add are never broken");
ok(mutants[0].op === "removed the guard" && mutants[0].line === 3 && mutants[0].after === "", "a one-line guard is removed");
ok(mutants[1].op.startsWith(">=") && mutants[1].after === "const big = qty > 100;", "a comparison is flipped");
ok(mutants[2].op === "removed the guard" && mutants[2].line === 5, "a guard with an error status is removed");

copyFileSync(join(dir, "src/app.ts"), join(dir, "orig.ts"));
for (let i = 0; i < mutants.length; i++) {
  run("apply", String(i));
  const broken = readFileSync(join(dir, "src/app.ts"), "utf8").split("\n");
  ok(broken[mutants[i].line - 1].trim() === mutants[i].after, `mutant ${i} changes only its line`);
  run("restore", String(i));
  ok(readFileSync(join(dir, "src/app.ts"), "utf8") === readFileSync(join(dir, "orig.ts"), "utf8"), `mutant ${i} is put back exactly`);
}

writeFileSync("/tmp/canon-mutants.out", "0 ok\n1 no\n2 ok\n");
const report = JSON.parse(run("report").replace(/^CANON_MUTANTS /, ""));
ok(report[0].preview === "p-0" && report[1].preview === null && report[2].preview === "p-2", "the report names each built mutant's preview, and none for one that didn't build");

process.exit(failed ? 1 : 0);
