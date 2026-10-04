// Runs demo-app/canon.json and the demo claims against a running app, using the
// referee's real evaluator. Seed facts must hold; claims must NOT hold yet
// (a claim that already holds on canon is not a new fact).
//
//   node scripts/check-local.ts http://localhost:8787
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../referee/src/probe.ts";

const origin = process.argv[2] ?? "http://localhost:8787";
const root = fileURLToPath(new URL("../", import.meta.url));
const seed = JSON.parse(readFileSync(join(root, "demo-app", "canon.json"), "utf8")).facts;
const claimsDir = join(root, "agents", "claims");
const claims = readdirSync(claimsDir).map((f) => JSON.parse(readFileSync(join(claimsDir, f), "utf8")));

let ok = true;
for (const f of seed) {
  const r = await runCheck(f.check, origin);
  ok &&= r.held;
  console.log(`${r.held ? "HOLDS " : "BROKEN"}  canon     ${f.id.padEnd(24)} ${r.detail}`);
}
for (const c of claims) {
  const r = await runCheck(c.check, origin);
  ok &&= !r.held;
  console.log(`${r.held ? "VACUOUS" : "fails "}  proposed  ${c.id.padEnd(24)} ${r.detail}`);
}
process.exit(ok ? 0 : 1);
