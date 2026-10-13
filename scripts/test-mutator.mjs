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
const at = (line) => mutants.find((m) => m.line === line);
ok(at(3)?.op === "removed the guard" && at(3)?.after === "", "a one-line guard is removed");
ok(at(4)?.op.startsWith(">=") && at(4)?.after === "const big = qty > 100;", "a comparison is flipped");
ok(at(5)?.op === "removed the guard", "a guard with an error status is removed");
ok(mutants.map((m) => m.line).join() === "3,5,4", "guards come before comparisons (the breaks that matter most first)");

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


// Stored data, retries and failure paths: the breaks a sequential happy-path check misses.
const dataBase = ["export class M {", "  constructor() {", "  }", "}", ""].join("\n");
const dataHead = [
  "export class M {",
  "  constructor() {",
  "    this.sql.exec(`CREATE TABLE IF NOT EXISTS bookings (stall INTEGER, day TEXT, name TEXT, PRIMARY KEY (stall, day))`);",
  "    this.sql.exec(`ALTER TABLE stalls ADD COLUMN hours TEXT NOT NULL DEFAULT '8am'`);",
  "    this.sql.exec(`INSERT INTO cart (id, qty) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET qty = qty + excluded.qty`, id, n);",
  "    this.sql.exec(`INSERT OR IGNORE INTO seen VALUES (?)`, key);",
  '    if (!stall) throw new Error("no such stall");',
  '    throw new Error("unreachable");',
  "  }",
  "}",
  "",
].join("\n");
writeFileSync(join(dir, "src/app.ts"), dataHead);
writeFileSync("/tmp/canon-mut-files.json", JSON.stringify([{ path: "src/app.ts", b64: Buffer.from(dataBase).toString("base64") }]));
const m2 = (Number(execFileSync("node", [mutator, "gen"], { cwd: dir, env: { ...process.env, MAX: "8" } }).toString().trim()), JSON.parse(readFileSync("/tmp/canon-mutants.json", "utf8")));
const op = (line) => m2.find((m) => m.line === line);
ok(op(3)?.op === "dropped the uniqueness constraint" && !op(3).after.includes("PRIMARY KEY"), "a composite primary key is dropped (two writers could both win)");
ok(op(4)?.op === "existing rows get no default" && !op(4).after.includes("DEFAULT"), "an added column loses its default (old rows)");
ok(op(5)?.op === "a repeated write overwrites instead of adding" && op(5).after.includes("qty = excluded.qty"), "a retried add overwrites instead of accumulating");
ok(op(6)?.op === "a duplicate replaces the original" && op(6).after.includes("INSERT OR REPLACE"), "a duplicate replaces instead of being ignored");
ok(op(7)?.op === "removed the check that fails the request" && op(7).after === "", "a failing check is removed");
ok(op(8)?.op === "swallowed the failure" && op(8).after === "", "a throw is swallowed");
ok(m2.slice(0, 4).every((m) => [3, 4, 5, 6].includes(m.line)), "data and retry breaks come first");
if (failed) process.exit(1);
