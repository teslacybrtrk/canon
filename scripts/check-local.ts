// Runs a canon.json against a running app, using the referee's real evaluator: every fact must hold.
// With no file given it checks the demo (demo-app/canon.json), whose claims must NOT hold yet
// (a claim that already holds on canon is not a new fact).
//
//   node scripts/check-local.ts http://localhost:8787                      the demo
//   node scripts/check-local.ts http://localhost:8787 ../my-app/canon.json  your app
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { runCheck } from "../referee/src/probe.ts";

const origin = process.argv[2] ?? "http://localhost:8787";
const root = fileURLToPath(new URL("../", import.meta.url));
const file = process.argv[3] ? resolve(process.argv[3]) : join(root, "demo-app", "canon.json");
const seed = JSON.parse(readFileSync(file, "utf8")).facts;
const claimsDir = join(root, "agents", "claims");
const claims = process.argv[3] ? [] : readdirSync(claimsDir).map((f) => JSON.parse(readFileSync(join(claimsDir, f), "utf8")));

// Command facts run next to the canon.json, as the CI pipeline runs them on an attempt's checkout.
async function check(c: any) {
  if (c.kind !== "command") return runCheck(c, origin);
  try {
    execSync(c.run, { cwd: dirname(file), stdio: "pipe", shell: "/bin/bash" });
    return { held: true, detail: "ok" };
  } catch (err: any) {
    return { held: false, detail: String(err.stderr || err.stdout || err.message).trim().split("\n").slice(-1)[0] };
  }
}

let ok = true;
for (const f of seed) {
  const r = await check(f.check);
  ok &&= r.held;
  console.log(`${r.held ? "HOLDS " : "BROKEN"}  canon     ${f.id.padEnd(24)} ${r.detail}`);
}
for (const c of claims) {
  const r = await check(c.check);
  ok &&= !r.held;
  console.log(`${r.held ? "VACUOUS" : "fails "}  proposed  ${c.id.padEnd(24)} ${r.detail}`);
}
process.exit(ok ? 0 : 1);
