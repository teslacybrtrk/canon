// The baseline: what plain Git would have shipped from the same run. Clones genesis and every agent's first attempt
// (read-only, from canon.rodeo), merges them all with `git merge` in claim order, as a merge queue whose only check
// is "it merges" would, then runs canon's facts and the agents' claimed facts against the merged app locally.
// Prints a Markdown report. Needs no keys.
//   node scripts/baseline.mjs [project] [port]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../referee/src/probe.ts";

const project = process.argv[2] ?? "farmstand";
const port = Number(process.argv[3] ?? 8788); // not 8787: other local tools use it
const origin = "https://canon.rodeo";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const state = await (await fetch(`${origin}/p/${project}/canon`)).json();

// The run's first-generation attempts (not the judge's re-applies), oldest claim first.
const firsts = state.claims.filter((c) => !c.refreshedFrom && c.verdict?.sha).sort((a, b) => a.createdAt - b.createdAt);
const work = mkdtempSync(join(tmpdir(), "canon-baseline-"));
const genesis = state.facts.length ? `${project}-genesis` : null;
git(tmpdir(), "clone", "-q", `${origin}/a/${genesis}.git`, work);
git(work, "config", "user.email", "baseline@canon.local");
git(work, "config", "user.name", "baseline");
const seedCanon = JSON.parse(readFileSync(join(work, "canon.json"), "utf8"));

const merges = [];
for (const c of firsts) {
  git(work, "fetch", "-q", `${origin}/a/${c.attemptId}.git`, "main");
  let conflicts = [];
  try {
    git(work, "merge", "-q", "--no-edit", "-m", `merge ${c.agent}: ${c.factId}`, "FETCH_HEAD");
  } catch {
    conflicts = git(work, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // canon.json is Canon's own file; plain Git has no use for it, so keep ours and judge only the code.
    if (conflicts.length && conflicts.every((f) => f === "canon.json")) {
      git(work, "checkout", "--ours", "canon.json");
      git(work, "add", "canon.json");
      git(work, "commit", "-q", "--no-edit");
      conflicts = [];
    } else {
      git(work, "merge", "--abort");
    }
  }
  merges.push({ claim: c, conflicts });
}

// Run the merged app locally and check every canon fact plus every fact the agents claimed.
execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: work, stdio: "pipe" });
const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: work, stdio: "pipe", detached: true });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(url)).status) break; } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
const claimed = new Map(firsts.map((c) => [c.factId, state.facts.find((f) => f.id === c.factId)]).filter(([, f]) => f));
const run = async (f) => (f.check.kind === "probe" ? runCheck(f.check, url) : command(f.check.run));
const command = (cmd) => {
  try { execFileSync("bash", ["-c", cmd], { cwd: work, stdio: "pipe" }); return { held: true, detail: "ok" }; }
  catch (e) { return { held: false, detail: String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-1)[0] }; }
};
const canonResults = [];
for (const f of seedCanon.facts) canonResults.push({ f, r: await run(f) });
const claimResults = [];
for (const [, f] of claimed) claimResults.push({ f, r: await run(f) });
try { process.kill(-dev.pid); } catch {}

const merged = merges.filter((m) => !m.conflicts.length);
const broken = canonResults.filter((x) => !x.r.held);
const out = [
  `# Baseline: the same run through plain Git`,
  ``,
  `Every agent's first attempt from the ${project} run, merged with \`git merge\` in the order they were claimed, as a`,
  `queue whose only gate is "it merges" would. Then canon's ${seedCanon.facts.length} facts and the agents' claimed facts were run against the merged app.`,
  ``,
  `**${merged.length} of ${merges.length} attempts merged cleanly. The merged app breaks ${broken.length} of canon's ${seedCanon.facts.length} facts.**`,
  ``,
  `| Agent | Claimed | git merge |`,
  `|---|---|---|`,
  ...merges.map((m) => `| ${m.claim.agent} | ${m.claim.sentence ?? m.claim.factId} | ${m.conflicts.length ? `text conflict in ${m.conflicts.join(", ")}: a person resolves it by reading the code` : "merged cleanly"} |`),
  ``,
  `| Canon fact on the merged app | Result |`,
  `|---|---|`,
  ...canonResults.map(({ f, r }) => `| ${f.sentence} | ${r.held ? "holds" : `**broken**: ${r.detail}`} |`),
  ``,
  `| Fact an agent claimed | On the merged app |`,
  `|---|---|`,
  ...claimResults.map(({ f, r }) => `| ${f.sentence} | ${r.held ? "holds" : `does not hold: ${r.detail}`} |`),
  ``,
  `Canon, on the same attempts: each was judged on its own live preview against every canon fact, so the ones that`,
  `broke a fact were rejected before anything merged, and clashing attempts were flagged before anyone accepted either.`,
];
console.log(out.join("\n"));
