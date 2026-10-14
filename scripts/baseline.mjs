// The baseline: what plain Git would have shipped from the same run. Clones genesis and every agent's first attempt
// (read-only, from canon.rodeo), merges them all with `git merge` in claim order, as a merge queue whose only check
// is "it merges" would, then runs canon's facts and the agents' claimed facts against the merged app locally.
// Then the same attempts through a conventional merge queue: each one lands only if it merges and the repo's own CI
// (type-check, lint) and the author's own test pass on the merged tree. Prints a Markdown report. Needs no keys.
//   node scripts/baseline.mjs [project] [port]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
const temps = [work];
process.on("exit", () => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
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
// A fixed seed per fact, so anyone who runs this gets the same inputs and the same report.
const run = async (f) => (f.check.kind === "probe" ? runCheck(f.check, url, `baseline:${f.id}`) : command(f.check.run));
const command = (cmd) => {
  try { execFileSync("bash", ["-c", cmd], { cwd: work, stdio: "pipe" }); return { held: true, detail: "ok" }; }
  catch (e) { return { held: false, detail: String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-1)[0] }; }
};
const canonResults = [];
for (const f of seedCanon.facts) canonResults.push({ f, r: await run(f) });
const claimResults = [];
for (const [, f] of claimed) claimResults.push({ f, r: await run(f) });
try { process.kill(-dev.pid); } catch {}

// A conventional merge queue: one attempt at a time, gated on the repo's CI and the author's own test on the merged tree.
const ci = seedCanon.facts.filter((f) => f.check.kind === "command" && ["code-typechecks", "code-lints"].includes(f.id));
const qwork = mkdtempSync(join(tmpdir(), "canon-queue-"));
temps.push(qwork);
git(tmpdir(), "clone", "-q", `${origin}/a/${genesis}.git`, qwork);
git(qwork, "config", "user.email", "baseline@canon.local");
git(qwork, "config", "user.name", "baseline");
execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: qwork, stdio: "pipe" });
const qport = port + 1;
const qurl = `http://127.0.0.1:${qport}`;
const startApp = async () => {
  const p = spawn("npx", ["wrangler", "dev", "--port", String(qport), "--ip", "127.0.0.1"], { cwd: qwork, stdio: "pipe", detached: true });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(qurl)).status) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return p;
};
const stopApp = async (p) => { try { process.kill(-p.pid); } catch {} await new Promise((r) => setTimeout(r, 1500)); };
const qcommand = (cmd) => {
  try { execFileSync("bash", ["-c", cmd], { cwd: qwork, stdio: "pipe" }); return { held: true, detail: "ok" }; }
  catch (e) { return { held: false, detail: String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-1)[0] }; }
};
const qrun = async (f) => (f.check.kind === "probe" ? runCheck(f.check, qurl, `baseline:${f.id}`) : qcommand(f.check.run));
const queue = [];
for (const c of firsts) {
  git(qwork, "fetch", "-q", `${origin}/a/${c.attemptId}.git`, "main");
  const before = git(qwork, "rev-parse", "HEAD");
  let outcome;
  try {
    git(qwork, "merge", "-q", "--no-edit", "-m", `merge ${c.agent}: ${c.factId}`, "FETCH_HEAD");
  } catch {
    const conflicts = git(qwork, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (conflicts.length && conflicts.every((f) => f === "canon.json")) {
      git(qwork, "checkout", "--ours", "canon.json");
      git(qwork, "add", "canon.json");
      git(qwork, "commit", "-q", "--no-edit");
    } else {
      git(qwork, "merge", "--abort");
      outcome = `bounced: text conflict in ${conflicts.join(", ")}`;
    }
  }
  if (!outcome) {
    const failedCi = ci.map((f) => ({ f, r: qcommand(f.check.run) })).find((x) => !x.r.held);
    const own = claimed.get(c.factId);
    let ownResult = { held: true };
    if (!failedCi && own) {
      const app = await startApp();
      ownResult = await qrun(own);
      await stopApp(app);
    }
    if (failedCi) outcome = `bounced: CI failed (${failedCi.f.sentence})`;
    else if (!ownResult.held) outcome = `bounced: its own test failed on the merged tree (${ownResult.detail})`;
    else outcome = "landed";
    if (outcome !== "landed") git(qwork, "reset", "-q", "--hard", before);
  }
  queue.push({ claim: c, outcome });
}
const qapp = await startApp();
const queueResults = [];
for (const f of seedCanon.facts) queueResults.push({ f, r: await qrun(f) });
await stopApp(qapp);
const qlanded = queue.filter((q) => q.outcome === "landed");
const qbroken = queueResults.filter((x) => !x.r.held);

const merged = merges.filter((m) => !m.conflicts.length);
const broken = canonResults.filter((x) => !x.r.held);
const out = [
  `# Baseline: the same run through plain Git`,
  ``,
  `The first attempt of each claim in the ${project} run, merged with \`git merge\` in the order they were claimed, as a`,
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
  `## A conventional merge queue, same attempts`,
  ``,
  `The same attempts in the same order, through a queue that lands one only if it merges and the repo's own CI`,
  `(${ci.map((f) => f.sentence.toLowerCase()).join("; ")}) and the author's own test pass on the merged tree.`,
  ``,
  `**${qlanded.length} of ${queue.length} landed. The queued app breaks ${qbroken.length} of canon's ${seedCanon.facts.length} facts${qbroken.length ? `: ${qbroken.map(({ f }) => `"${f.sentence}"`).join(", ")}` : ""}.**`,
  ``,
  `| Agent | Claimed | Merge queue |`,
  `|---|---|---|`,
  ...queue.map((q) => `| ${q.claim.agent} | ${q.claim.sentence ?? q.claim.factId} | ${q.outcome} |`),
  ``,
  ...qbroken.map(({ f, r }) => `- **${f.sentence}**: broken on the queued app: ${r.detail}`),
  ...(qbroken.length ? [``] : []),
  `Canon, on the same attempts: each was judged on its own live preview against every canon fact, so the ones that`,
  `broke a fact were rejected before anything merged, and clashing attempts were flagged before anyone accepted either.`,
];
console.log(out.join("\n"));
