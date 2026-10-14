// The integration-under-load workload through a conventional merge queue, for comparison with Canon's runs (README):
// 30 attempts, cycling over 8 backlog features, each branched from genesis with its own change (scripts/load-patches.py),
// queued in push order. An attempt lands only if it merges cleanly onto main and the repo's CI (type-check, lint) and
// its author's own test (its claimed fact's probe) pass on the merged tree. Everything else bounces to a person.
//   node scripts/queue-under-load.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../referee/src/probe.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const backlog = JSON.parse(readFileSync(join(ROOT, "agents/canon.autopilot.json"), "utf8")).backlog;
const features = ["line-limit", "sold-out-refused", "search-by-name", "product-page", "stall-products", "no-double-booking", "remove-from-basket", "stall-hours"];
const patchOf = { "no-double-booking": "no-double-booking2", "remove-from-basket": "remove-from-basket2" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const work = mkdtempSync(join(tmpdir(), "canon-qload-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const main = join(work, "main");
cpSync(join(ROOT, "demo-app"), main, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".wrangler") });
symlinkSync(join(ROOT, "demo-app/node_modules"), join(main, "node_modules"));
git(main, "init", "-q", "-b", "main");
git(main, "add", "-A");
git(main, "-c", "user.name=q", "-c", "user.email=q@q", "commit", "-qm", "genesis");
const genesis = git(main, "rev-parse", "HEAD");

// Each attempt: a branch from genesis with its feature applied.
for (let n = 1; n <= 30; n++) {
  const f = features[(n - 1) % 8];
  git(main, "checkout", "-q", "-b", `a${n}`, genesis);
  execFileSync("python3", [join(ROOT, "scripts/load-patches.py"), main, patchOf[f] ?? f], { stdio: "pipe" });
  git(main, "-c", "user.name=q", "-c", "user.email=q@q", "commit", "-qam", `a${n} ${f}`);
}
git(main, "checkout", "-q", "main");

const ci = (cwd) => {
  for (const cmd of ["npx tsc --noEmit -p tsconfig.json", "npx biome lint src"]) {
    try { execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" }); } catch { return false; }
  }
  return true;
};
const ownTest = async (fact) => {
  const port = 8799;
  const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: main, stdio: "pipe", detached: true });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
  const r = await runCheck(fact.check, url, `queue:${fact.id}`);
  try { process.kill(-dev.pid); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  return r.held;
};

const landed = new Set();
const out = { landedAttempts: 0, featuresLanded: 0, conflicts: 0, ciFailed: 0, ownTestFailed: 0, emptyOrDuplicate: 0 };
for (let n = 1; n <= 30; n++) {
  const f = features[(n - 1) % 8];
  const before = git(main, "rev-parse", "HEAD");
  try {
    git(main, "-c", "user.name=q", "-c", "user.email=q@q", "merge", "-q", "--no-edit", `a${n}`);
  } catch {
    git(main, "merge", "--abort");
    out.conflicts++;
    continue;
  }
  if (git(main, "rev-parse", "HEAD") === before) { out.emptyOrDuplicate++; continue; }
  if (!ci(main)) { git(main, "reset", "-q", "--hard", before); out.ciFailed++; continue; }
  const fact = backlog.find((b) => b.id === f);
  if (!(await ownTest(fact))) { git(main, "reset", "-q", "--hard", before); out.ownTestFailed++; continue; }
  out.landedAttempts++;
  landed.add(f);
}
out.featuresLanded = landed.size;
console.log(JSON.stringify({ ...out, features: [...landed] }, null, 1));
