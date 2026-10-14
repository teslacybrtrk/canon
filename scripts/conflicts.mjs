// Designed behavioural conflicts, run locally (docs/conflicts.md). Every case in conflicts/cases/ is a change A and a
// change B, both branched from one base app (conflicts/app), that Git merges without a text conflict (one case
// conflicts on purpose) and that together break a requirement, or, for the controls, don't. For each case this builds
// a temp Git repo, applies A and B as branches, runs plain `git merge`, applies the case author's reference resolution,
// and checks every requirement (canon's facts in conflicts/app/canon.json plus each change's claimed fact) on a local
// `wrangler dev` of A alone, B alone, the combined code and the resolution, with the judge's own evaluator. The same
// results are then read as two systems would act on them: plain Git (whatever merges is delivered) and a merge queue
// gated on the same checks (A lands, B is tested on base+A and bounces if a check fails, then the resolution lands).
// Deployed Canon is run separately; its results go in docs/conflicts/deployed.json and are rendered beside these.
//
//   node scripts/conflicts.mjs [--cases id,id] [--port 8860] [--keep]
//   node scripts/conflicts.mjs --render [--deployed <file>]   the report again from docs/conflicts/results.json, with the
//     deployed run's results (docs/conflicts/deployed.json unless --deployed names another file)
import { execFileSync, spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, templateNames } from "../referee/src/probe.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith("--")) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true; });
const APP = join(ROOT, "conflicts/app");
const CASES = join(ROOT, "conflicts/cases");
const RESULTS = join(ROOT, "docs/conflicts/results.json");
const DEPLOYED = args.deployed ? String(args.deployed) : join(ROOT, "docs/conflicts/deployed.json");
const REPORT = join(ROOT, "docs/conflicts.md");
// The order the report lists them in: the conflict classes, then the controls. Any other case directory comes after.
const ORDER = ["vat-on-list-price", "hidden-sold-out", "limit-lost-in-repair", "basket-shape", "dollars-and-cents", "shared-threshold", "strict-fields", "double-discount", "control-vat-per-line", "control-basket-shape", "control-threshold"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=conflicts", "-c", "user.email=conflicts@canon.local", ...a], { cwd, stdio: "pipe" }).toString().trim();
const secs = (ms) => Math.round(ms / 100) / 10;
const canon = JSON.parse(readFileSync(join(APP, "canon.json"), "utf8")).facts;

// ---- Cases ------------------------------------------------------------------------------------------------------

function loadCases() {
  const ids = readdirSync(CASES).filter((d) => existsSync(join(CASES, d, "case.json")));
  const ordered = [...ORDER.filter((id) => ids.includes(id)), ...ids.filter((id) => !ORDER.includes(id)).sort()];
  const byId = new Map(canon.map((f) => [f.id, JSON.stringify(f)]));
  return ordered.map((id) => {
    const c = JSON.parse(readFileSync(join(CASES, id, "case.json"), "utf8"));
    const factA = c.a.fact;
    const factB = c.b.fact ?? (c.b.join === factA.id ? factA : null);
    if (!factB) throw new Error(`${id}: b needs its own fact, or "join" naming A's fact`);
    for (const f of [factA, factB]) {
      const bad = validate(f);
      if (bad) throw new Error(`${id}: fact ${f.id}: ${bad}`);
      // One id, one definition, across every case and canon: results on the shared base are kept by id.
      if (byId.has(f.id) && byId.get(f.id) !== JSON.stringify(f)) throw new Error(`${id}: fact ${f.id} differs from another definition with that id`);
      byId.set(f.id, JSON.stringify(f));
    }
    return { ...c, factA, factB, hasResolution: existsSync(join(CASES, id, "resolution.patch")) };
  });
}

// The judge's own rules for a fact (validateCheck in referee/src/referee.ts), the parts a case could get wrong, so the
// facts here are accepted by the deployed judge as they are.
function validate(f) {
  const c = f.check;
  if (!f.id || !f.sentence || !c) return "a fact needs an id, a sentence and a check";
  if (c.kind === "command") return typeof c.run === "string" && c.run.trim() ? null : "a command check needs run";
  if (c.kind !== "probe" || !c.steps?.length) return "a check is a probe with steps, or a command";
  if (!c.steps.some((s) => s.expect)) return "a check with no expectations cannot fail";
  if (c.samples !== undefined && !(Number.isInteger(c.samples) && c.samples >= 1 && c.samples <= 10)) return "samples must be 1-10";
  const known = new Set(Object.keys(c.vars ?? {}));
  for (const s of c.steps) {
    if (typeof s.path !== "string" || !s.path.startsWith("/")) return "every step needs a path starting with /";
    const unknown = templateNames([s.path, s.body, s.expect]).find((n) => !known.has(n));
    if (unknown) return `{{${unknown}}} is not an input or a value an earlier step saved`;
    for (const n of Object.keys(s.save ?? {})) known.add(n);
  }
  return null;
}

const factsOf = (c) => [...canon, c.factA, ...(c.factB.id === c.factA.id ? [] : [c.factB])];
const lines = (patch) => {
  const text = readFileSync(patch, "utf8").split("\n");
  return { added: text.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, removed: text.filter((l) => l.startsWith("-") && !l.startsWith("---")).length };
};

// ---- A case's trees: base, A, B, A+B (git merge), and the reference resolution on top --------------------------------

function buildRepo(c, work) {
  const dir = mkdtempSync(join(work, `${c.id}-`));
  cpSync(APP, dir, { recursive: true, filter: (p) => !/node_modules|\.wrangler/.test(p) });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const sha = { base: git(dir, "rev-parse", "HEAD") };
  for (const side of ["a", "b"]) {
    git(dir, "checkout", "-q", "-b", side, sha.base);
    git(dir, "apply", "--index", join(CASES, c.id, `${side}.patch`));
    git(dir, "commit", "-qm", `${side.toUpperCase()}: ${c[side].why}`);
    sha[side] = git(dir, "rev-parse", "HEAD");
  }
  // Plain Git: B merged into A. A text conflict is left to a person; a case that seeds one resolves it the seeded way.
  git(dir, "checkout", "-q", "-b", "combined", sha.a);
  const t0 = Date.now();
  const merge = { clean: true, conflicted: [], ms: 0 };
  try {
    git(dir, "merge", "--no-edit", "-q", "b");
  } catch {
    merge.clean = false;
    merge.conflicted = git(dir, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    git(dir, "merge", "--abort");
  }
  merge.ms = Date.now() - t0;
  if (!merge.clean) {
    if (!c.repair) throw new Error(`${c.id}: an unexpected text conflict in ${merge.conflicted.join(", ")}`);
    git(dir, "merge", "--no-edit", "-q", "-X", c.repair.strategy, "b");
    merge.repaired = c.repair.label;
  }
  sha.combined = git(dir, "rev-parse", "HEAD");
  if (c.hasResolution) {
    git(dir, "apply", "--index", join(CASES, c.id, "resolution.patch"));
    git(dir, "commit", "-qm", "reference resolution (written by the case author)");
    sha.resolved = git(dir, "rev-parse", "HEAD");
  }
  return { dir, sha, merge };
}

// ---- Checks on a tree: command facts in a checkout, probe facts on a local wrangler dev ---------------------------

let nextPort = Number(args.port ?? 8860);
const servers = new Set();
const killAll = () => { for (const p of servers) { try { process.kill(-p.pid, "SIGKILL"); } catch {} } servers.clear(); };
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAll(); process.exit(130); });

// A server that never comes up is the harness's failure, not the code's: it's started again, up to three times.
async function serve(dir, work) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = nextPort++;
    const log = openSync(join(work, `wrangler-${port}.log`), "w");
    const p = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", mkdtempSync(join(work, "state-")), "--show-interactive-dev-session=false"], {
      cwd: dir, stdio: ["ignore", log, log], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    closeSync(log);
    servers.add(p);
    const url = `http://127.0.0.1:${port}`;
    const stop = async () => {
      try { process.kill(-p.pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 20 && p.exitCode === null && p.signalCode === null; i++) await sleep(100);
      try { process.kill(-p.pid, "SIGKILL"); } catch {}
      servers.delete(p);
    };
    for (let i = 0; i < 240; i++) {
      try { await fetch(url); return { url, stop }; } catch {}
      await sleep(250);
    }
    await stop();
  }
  throw new Error(`infrastructure: a local wrangler dev never started (${dir})`);
}

function command(dir, f) {
  const t0 = Date.now();
  try {
    execFileSync("bash", ["-c", f.check.run], { cwd: dir, stdio: "pipe" });
    return { held: true, detail: "ok", ms: Date.now() - t0 };
  } catch (e) {
    // The diagnostic, not the summary: tsc's first error, or biome's rule and its message.
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").map((l) => l.replace(/━+/g, "").trim()).filter(Boolean);
    const at = out.findIndex((l) => /error TS\d+|lint\/\w+/.test(l));
    const detail = at < 0 ? (out.find((l) => /error/i.test(l)) ?? out.pop() ?? e.message) : `${out[at]}${out[at + 1]?.startsWith("×") ? `: ${out[at + 1].slice(1).trim()}` : ""}`;
    return { held: false, detail: detail.slice(0, 300), ms: Date.now() - t0 };
  }
}

// Inputs come from a fixed seed per fact, so every tree gets the same draws and a re-run reproduces the report. A
// refused connection is the local server, not the code: it's tried again. A real failure is run once more (a fresh
// run, the same inputs) before it counts; a pass the second time is kept, with a note.
async function probe(f, url) {
  const seed = `conflicts:${f.id}`;
  let r = await runCheck(f.check, url, seed);
  const ms = r.ms;
  for (let i = 0; i < 5 && !r.held && /fetch failed|ECONNREFUSED|ECONNRESET|socket/i.test(r.detail); i++) {
    await sleep(2_000);
    r = await runCheck(f.check, url, seed);
  }
  if (r.held) return { held: true, detail: "ok", ms };
  const again = await runCheck(f.check, url, seed);
  return again.held ? { held: true, detail: "ok", ms, note: `failed once (${r.detail}), held on a re-run` } : { held: false, detail: r.detail, ms };
}

async function checkTree(repo, sha, facts, work) {
  const dir = mkdtempSync(join(work, "tree-"));
  execFileSync("bash", ["-c", `git archive ${sha} | tar -x -C '${dir}'`], { cwd: repo });
  symlinkSync(join(ROOT, "demo-app/node_modules"), join(dir, "node_modules"));
  const results = {};
  for (const f of facts.filter((x) => x.check.kind === "command")) results[f.id] = command(dir, f);
  const t0 = Date.now();
  const server = await serve(dir, work);
  const startMs = Date.now() - t0;
  for (const f of facts.filter((x) => x.check.kind === "probe")) results[f.id] = await probe(f, server.url);
  await server.stop();
  return { sha: sha.slice(0, 12), startMs, results };
}

// ---- What each system makes of the results ----------------------------------------------------------------------

// The time a set of checks takes on a tree: the local server's start, then each fact's own run.
const stageMs = (tree, ids) => tree.startMs + ids.reduce((sum, id) => sum + tree.results[id].ms, 0);
const failing = (tree, ids) => ids.filter((id) => !tree.results[id].held).map((id) => ({ id, detail: tree.results[id].detail }));

function assess(c, base, merge, trees) {
  const canonIds = canon.map((f) => f.id);
  const A = c.factA.id, B = c.factB.id;
  const ids = { a: [...canonIds, A], b: [...canonIds, B], all: [...new Set([...canonIds, A, B])] };
  const resolved = trees.resolved ?? trees.combined;
  const out = {
    vacuous: [...new Set([A, B])].filter((id) => base.results[id].held),
    aAlone: failing(trees.a, ids.a),
    bAlone: failing(trees.b, ids.b),
    combined: failing(trees.combined, ids.all),
    resolved: failing(resolved, ids.all),
    // Each claimed fact on the other change alone: data for comparing with Canon's clash warnings, not used here.
    cross: { [`${B} on A`]: trees.a.results[B], [`${A} on B`]: trees.b.results[A] },
    notes: Object.entries(trees).flatMap(([name, t]) => Object.entries(t.results).filter(([, r]) => r.note).map(([id, r]) => `${name}: ${id} ${r.note}`)),
  };
  const deviations = [];
  if ((merge.clean ? "clean" : "conflict") !== c.merge) deviations.push(`designed to merge ${c.merge === "clean" ? "cleanly" : "with a text conflict"}, but it ${merge.clean ? "merged cleanly" : "conflicted"}`);
  if (out.vacuous.length) deviations.push(`a claimed fact already holds on the base: ${out.vacuous.join(", ")}`);
  if (out.aAlone.length) deviations.push(`A alone fails ${out.aAlone.map((x) => x.id).join(", ")}`);
  if (out.bAlone.length) deviations.push(`B alone fails ${out.bAlone.map((x) => x.id).join(", ")}`);
  const got = out.combined.map((x) => x.id);
  const want = c.expect?.combinedFails ?? [];
  if (c.kind === "control" && got.length) deviations.push(`a control, but the combined code fails ${got.join(", ")}`);
  if (c.kind !== "control" && (!got.length || !want.every((id) => got.includes(id)))) deviations.push(`expected the combined code to fail ${want.join(", ")}; it fails ${got.join(", ") || "nothing"}`);
  if (out.resolved.length) deviations.push(`the reference resolution fails ${out.resolved.map((x) => x.id).join(", ")}`);

  // Plain Git: nothing checks the merge. A clean merge is delivered as it is; a text conflict waits for a person, and
  // the case's seeded resolution is what gets delivered.
  const plain = { textMerge: merge.clean, conflicted: merge.conflicted, mergeSeconds: secs(merge.ms), delivered: true, broken: got, interventions: merge.clean ? 0 : 1 };
  // The merge queue, gated on the same checks: A on the base, then B on base+A (after the text conflict, if any, is
  // resolved by B's author and resubmitted), then the fix on base+A when B bounced.
  const bounces = [];
  if (!merge.clean) bounces.push({ why: `text conflict in ${merge.conflicted.join(", ")}`, seconds: secs(merge.ms) });
  const b = { seconds: secs(merge.ms + stageMs(trees.combined, ids.all)), failing: out.combined };
  if (b.failing.length) bounces.push({ why: `failed ${b.failing.map((x) => x.id).join(", ")}`, seconds: b.seconds });
  const fix = b.failing.length && trees.resolved ? { seconds: secs(stageMs(trees.resolved, ids.all)), failing: out.resolved } : null;
  const queue = {
    a: { seconds: secs(stageMs(trees.a, ids.a)), landed: !out.aAlone.length },
    b: { ...b, landed: !b.failing.length },
    bounces,
    fix: fix && { ...fix, landed: !fix.failing.length },
    detectSeconds: b.failing.length ? b.seconds : null,
    resolveSeconds: fix ? fix.seconds : null,
    delivered: b.failing.length ? (fix && !fix.failing.length ? "the resolution" : "nothing yet") : "A and B",
    broken: [], // it lands only what passed every check
    interventions: bounces.length,
  };
  return { ...out, deviations, asDesigned: !deviations.length, plain, queue };
}

// ---- Run --------------------------------------------------------------------------------------------------------

async function run() {
  const all = loadCases();
  const chosen = args.cases ? all.filter((c) => String(args.cases).split(",").includes(c.id)) : all;
  const work = mkdtempSync(join(tmpdir(), "canon-conflicts-"));
  const t0 = Date.now();
  const revision = (() => { try { return git(ROOT, "rev-parse", "--short=12", "HEAD"); } catch { return "unknown"; } })();
  // Cases or a runner that differ from that commit are said so: the revision alone wouldn't reproduce the run.
  const dirty = (() => { try { return git(ROOT, "status", "--porcelain", "--", "conflicts", "scripts/conflicts.mjs") !== ""; } catch { return false; } })();
  process.stderr.write(`checking the base with every fact (${work})\n`);
  // The base, once: canon must hold, and no claimed fact may hold yet (a fact that already holds is no new requirement).
  const baseRepo = mkdtempSync(join(work, "base-"));
  cpSync(APP, baseRepo, { recursive: true, filter: (p) => !/node_modules|\.wrangler/.test(p) });
  git(baseRepo, "init", "-q", "-b", "main");
  git(baseRepo, "add", "-A");
  git(baseRepo, "commit", "-qm", "base");
  const claimed = [...new Map(all.flatMap((c) => [c.factA, c.factB]).map((f) => [f.id, f])).values()];
  const base = await checkTree(baseRepo, git(baseRepo, "rev-parse", "HEAD"), [...canon, ...claimed], work);
  const cases = [];
  for (const c of chosen) {
    process.stderr.write(`${c.id}\n`);
    const started = Date.now();
    const repo = buildRepo(c, work);
    const trees = {};
    for (const name of ["a", "b", "combined", "resolved"]) {
      if (!repo.sha[name]) continue;
      process.stderr.write(`  ${name}\n`);
      trees[name] = await checkTree(repo.dir, repo.sha[name], factsOf(c), work);
    }
    const verdict = assess(c, base, repo.merge, trees);
    process.stderr.write(`  ${verdict.asDesigned ? "as designed" : `NOT as designed: ${verdict.deviations.join("; ")}`}\n`);
    const { factA, factB, ...rest } = c;
    cases.push({
      ...rest,
      facts: { a: factA, b: factB },
      size: { a: lines(join(CASES, c.id, "a.patch")), b: lines(join(CASES, c.id, "b.patch")), ...(c.hasResolution ? { resolution: lines(join(CASES, c.id, "resolution.patch")) } : {}) },
      merge: { clean: repo.merge.clean, conflicted: repo.merge.conflicted, seconds: repo.merge.ms / 1000, ...(repo.merge.repaired ? { repaired: repo.merge.repaired } : {}) },
      trees,
      ...verdict,
      seconds: secs(Date.now() - started),
    });
  }
  killAll();
  if (!args.keep) rmSync(work, { recursive: true, force: true });
  const wrangler = JSON.parse(readFileSync(join(ROOT, "demo-app/node_modules/wrangler/package.json"), "utf8")).version;
  const results = {
    revision, dirty, date: new Date().toISOString(), seconds: secs(Date.now() - t0),
    conditions: { machine: `${platform()} ${release()}, ${cpus()[0]?.model ?? "unknown CPU"}`, node: process.version, wrangler, git: git(ROOT, "--version").replace("git version ", ""), runs: "one check run at a time (sequential), local wrangler dev" },
    base: { startMs: base.startMs, results: base.results },
    cases,
  };
  // A partial run (--cases) keeps the other cases' results from the last full run.
  if (args.cases && existsSync(RESULTS)) {
    const old = JSON.parse(readFileSync(RESULTS, "utf8"));
    results.cases = all.map((c) => cases.find((x) => x.id === c.id) ?? old.cases.find((x) => x.id === c.id)).filter(Boolean);
    results.partial = `re-ran ${cases.map((c) => c.id).join(", ")}; the other cases are from ${old.date}`;
  }
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 1)}\n`);
  return results;
}

// ---- Report -----------------------------------------------------------------------------------------------------

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s) => `\`${s}\``;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const range = (xs) => (!xs.length ? "none" : xs.length === 1 ? `${xs[0]} s (one case)` : Math.min(...xs) === Math.max(...xs) ? `${xs[0]} s in every case` : `median ${Math.round(median(xs) * 10) / 10} s (${Math.min(...xs)}–${Math.max(...xs)} s)`);
const fails = (list) => list.map((x) => `${code(x.id)}: ${x.detail}`).join("; ");

function render(results, deployed) {
  const cs = results.cases;
  const conflicts = cs.filter((c) => c.kind !== "control");
  const controls = cs.filter((c) => c.kind === "control");
  const d = (c) => deployed?.cases?.[c.id];
  const pending = "_pending_";
  const n = canon.length;
  const sentence = (id, c) => (c.facts.a.id === id ? c.facts.a : c.facts.b.id === id ? c.facts.b : canon.find((f) => f.id === id))?.sentence ?? id;
  const out = [
    "<!-- Generated by scripts/conflicts.mjs from docs/conflicts/results.json (and docs/conflicts/deployed.json, when present). -->",
    "# Designed behavioural conflicts",
    "",
    `Generated by \`scripts/conflicts.mjs\` on ${results.date.slice(0, 10)} (UTC) at revision \`${results.revision}\`${results.dirty ? ", with the cases or the runner not yet committed" : ""}${results.partial ? ` (${results.partial})` : ""}; the run took ${results.seconds} s. ${cs.length} cases, **every one deliberately seeded**: written by Canon's author so that each shows one way two changes that Git merges (cleanly in all but the one designed text conflict) still break a requirement together (${conflicts.length} cases, one class each), or touch the same code and are fine together (${controls.length} controls). They are not drawn from real agent work. Everything below except the Canon column was measured locally; the Canon column comes from a separate run on the deployed judge.`,
    "",
    "## What a case is",
    "",
    `A shared base, [conflicts/app](../conflicts/app): a small shop Worker in seven modules (catalog, pricing, tax, money formatting, config, a basket Durable Object, the shop page) and a router. A change A and a change B, both branched from the base, each with the fact it claims. A reference resolution, **written by the case author**, applied on top of the merge to show that both requirements can hold together. Each case is a directory in [conflicts/cases](../conflicts/cases): \`a.patch\`, \`b.patch\`, \`resolution.patch\` and \`case.json\` (the class, the story, both claimed facts and what the author expected).`,
    "",
    `The requirements are Canon facts in Canon's own format, so they run on the deployed judge unchanged: the ${n} canon facts in [conflicts/app/canon.json](../conflicts/app/canon.json), which every version must keep (pricing and VAT, the basket, the shop page, type-checking and lint), plus the fact each change claims.`,
    "",
    "## How they were checked",
    "",
    `For every case, \`scripts/conflicts.mjs\` builds a temp Git repo from the base, commits A and B as branches, merges B into A with plain \`git merge\`, and commits the reference resolution on top. Each tree (A alone, B alone, the combined code, the resolution) is served by a local \`wrangler dev\` and checked against every canon fact and both claimed facts, with the judge's own evaluator (\`referee/src/probe.ts\`); the command facts (\`tsc\`, \`biome\`) run in the tree's checkout. Probe inputs are drawn from a fixed seed per fact, so every tree gets the same inputs and a re-run gives the same report (Canon draws them after each push instead). A failing check is run once more before it counts. Before the cases, the base is checked once: every canon fact must hold on it, and no claimed fact may (a fact that already holds is no new requirement).`,
    "",
    "## The systems compared",
    "",
    "- **Plain Git.** `git merge` of B into A. Nothing checks the result: whatever merges is delivered. A text conflict waits for a person; the case's seeded resolution is what gets delivered.",
    `- **Merge queue running the same checks** (a local model, not a product). It is gated on exactly Canon's facts: the ${n} canon facts plus each change's claimed fact, A's becoming a protected check once A lands. A is tested on the base and lands; B is merged onto base+A and tested; a text conflict bounces B to its author, who resolves it (the seeded resolution) and resubmits; a failing check bounces B; then the reference resolution is tested and lands. Configuration differences from Canon: local servers instead of Workers Previews, fixed seeds instead of inputs drawn after each push, no repair model (Canon re-applies B onto the new canon itself, 3-way and then with its repair model for a text conflict), and no clash warnings before an accept. The queue has the other change's behavioural requirement as a protected check by construction; a team's CI often runs only each branch's own tests, which travel with the branch.`,
    `- **Canon (deployed judge).** ${deployed?.setup ?? "Run separately on the deployed judge; the column stays pending until docs/conflicts/deployed.json holds that run's results (see the last section)."}`,
    "",
    "## Timing: where it starts and ends",
    "",
    "- **Detection time** starts when B is submitted onto a base that already includes A (the queue: B reaches the front after A landed; Canon: A lands on autopilot, so canon moves and the judge re-applies B by itself) and ends when the system reports that B fails (the queue's bounce; Canon's verdict on the re-applied attempt, as seen by the runner, which polls every 10 s).",
    "- **Resolution time** starts at that report and ends when a candidate holding both changes passes every check (the queue: the fix lands; Canon: from the fix's push, right after the failure was seen, to its Ready verdict). Here the fix is the pre-written reference resolution, so the time to write a fix is zero and only machine time is counted. A real resolution adds the time an agent or a person takes to write it, which this does not measure.",
    "- **Plain Git** checks nothing, so it detects nothing and resolves nothing: the broken result is delivered, and when someone notices is outside the system.",
    `- Local times are wall-clock seconds on one machine (${results.conditions.machine}; Node ${results.conditions.node}, wrangler ${results.conditions.wrangler}, git ${results.conditions.git}), ${results.conditions.runs}: each stage counts the local server's start (median ${secs(median(cs.flatMap((c) => Object.values(c.trees).map((t) => t.startMs))))} s) and each fact's own run. They are not comparable with deployed times, where every commit's preview is built and deployed first.`,
    "",
    "## Results by case",
    "",
    "Each change alone keeps every requirement it was checked against (canon's facts and its own claimed fact); the column says so or names what failed.",
    "",
    "| # | Case | Class | Seeded | git merge | A alone | B alone | A and B together | Reference resolution | As designed |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...cs.map((c, i) => {
      const alone = (f, k) => (f.length ? `fails ${fails(f)}` : `all ${k} hold`);
      const together = c.combined.length ? `**breaks** ${fails(c.combined)}` : "every requirement holds";
      const merge = c.merge.clean ? "clean" : `text conflict in ${c.merge.conflicted.join(", ")}; ${c.merge.repaired}`;
      const res = c.size.resolution ? (c.resolved.length ? `still fails ${fails(c.resolved)}` : `both hold (+${c.size.resolution.added} −${c.size.resolution.removed} lines)`) : "not needed (control)";
      return `| ${i + 1} | [${c.id}](#${c.id}) | ${cell(c.class)} | ${c.seeded ? "yes" : "no"} | ${cell(merge)} | ${cell(alone(c.aAlone, n + 1))} | ${cell(alone(c.bAlone, n + 1))} | ${cell(together)} | ${cell(res)} | ${c.asDesigned ? "yes" : `**no**: ${cell(c.deviations.join("; "))}`} |`;
    }),
    "",
    "## What each system did",
    "",
    "| # | Case | Plain Git | Merge queue, same checks (local) | Canon (deployed judge) |",
    "|---|---|---|---|---|",
    ...cs.map((c, i) => {
      const p = c.plain;
      const plain = p.textMerge
        ? (p.broken.length ? `merged and **delivered broken** (${p.broken.map(code).join(", ")})` : "merged and delivered; correct")
        : `text conflict: a person resolves it; the seeded resolution is ${p.broken.length ? `**delivered broken** (${p.broken.map(code).join(", ")})` : "delivered; correct"}`;
      const q = c.queue;
      const steps = [`A lands (${q.a.seconds} s)`];
      if (!c.merge.clean) steps.push("B bounces on the text conflict; its author resolves it the seeded way and resubmits");
      steps.push(q.b.landed ? `B lands (${q.b.seconds} s)` : `B **bounces**: ${q.b.failing.map((x) => code(x.id)).join(", ")} (${q.b.seconds} s)`);
      if (q.fix) steps.push(q.fix.landed ? `the fix lands (${q.fix.seconds} s)` : `the fix fails ${q.fix.failing.map((x) => code(x.id)).join(", ")}`);
      const dc = d(c);
      return `| ${i + 1} | ${c.id} | ${cell(plain)} | ${cell(steps.join("; "))} | ${dc ? cell(dc.outcome) : pending} |`;
    }),
    "",
    "## Comparison over the designed cases",
    "",
  ];
  const sum = (f) => conflicts.reduce((s, c) => s + f(c), 0);
  const dep = (f) => (deployed?.cases ? f(cs.filter((c) => d(c)).map((c) => [c, d(c)])) : pending);
  const depConflicts = (pred) => dep((rows) => `${rows.filter(([c, x]) => c.kind !== "control" && pred(x, c)).length} of ${rows.filter(([c]) => c.kind !== "control").length}`);
  const detect = conflicts.map((c) => c.queue.detectSeconds).filter((x) => x !== null);
  const resolve = conflicts.map((c) => c.queue.resolveSeconds).filter((x) => x !== null);
  const depTimes = (key) => dep((rows) => range(rows.map(([, x]) => x[key]).filter((v) => typeof v === "number")));
  out.push(
    "| | Plain Git | Merge queue, same checks (local) | Canon (deployed judge) |",
    "|---|---|---|---|",
    `| Textual merge succeeded (conflict cases) | ${sum((c) => (c.merge.clean ? 1 : 0))} of ${conflicts.length} | ${sum((c) => (c.merge.clean ? 1 : 0))} of ${conflicts.length} (the same merge) | ${dep((rows) => `${rows.filter(([c, x]) => c.kind !== "control" && x.reapplied === "clean").length} of ${rows.filter(([c]) => c.kind !== "control").length} re-applied without a text conflict`)} |`,
    `| Behavioural failures detected (conflict cases) | 0 of ${conflicts.length} | ${sum((c) => (c.queue.b.failing.length ? 1 : 0))} of ${conflicts.length} | ${depConflicts((x) => x.detected)} |`,
    `| Broken results delivered (conflict cases) | ${sum((c) => (c.plain.broken.length ? 1 : 0))} of ${conflicts.length}${conflicts.some((c) => !c.merge.clean) ? " (the text conflict only with the seeded resolution)" : ""} | ${sum((c) => (c.queue.broken.length ? 1 : 0))} of ${conflicts.length} | ${depConflicts((x) => x.delivered)} |`,
    `| Controls: both changes accepted | ${controls.filter((c) => !c.plain.broken.length && c.merge.clean).length} of ${controls.length} | ${controls.filter((c) => c.queue.b.landed).length} of ${controls.length} | ${dep((rows) => `${rows.filter(([c, x]) => c.kind === "control" && x.accepted).length} of ${rows.filter(([c]) => c.kind === "control").length}`)} |`,
    `| Repair done by the system itself | none | none: B goes back to its author | ${dep((rows) => rows.filter(([, x]) => x.repair).map(([c, x]) => `${c.id}: ${x.repair}`).join("; ") || "none")} |`,
    `| Interventions to get both requirements to hold | ${sum((c) => c.plain.interventions)} (resolving the text conflict); nothing flags the ${sum((c) => (c.plain.broken.length ? 1 : 0))} broken results, so fixing them needs someone to notice first | ${sum((c) => c.queue.interventions)}: one fix written per bounce, plus resolving the text conflict | ${dep((rows) => String(rows.filter(([c]) => c.kind !== "control").reduce((s, [, x]) => s + (x.interventions ?? 0), 0)))} |`,
    `| Time to detect (B submitted onto base+A → its failure reported) | never: nothing checks | ${range(detect)} | ${depTimes("detectSeconds")} |`,
    `| Time to resolve, machine time (failure reported → a fix passes every check; writing the fix not counted) | never: the broken result is delivered | ${range(resolve)} | ${depTimes("resolveSeconds")} |`,
    "",
    `Can both requirements hold together? ${(() => { const k = sum((c) => (c.size.resolution && !c.resolved.length ? 1 : 0)); return k === conflicts.length ? `In all ${k} conflict cases, yes` : `In ${k} of the ${conflicts.length} conflict cases, yes`; })()}: the reference resolution (written by the case author; ${(() => { const n = conflicts.filter((c) => c.size.resolution).map((c) => c.size.resolution.added + c.size.resolution.removed); return `${median(n)} changed lines at the median, ${Math.min(...n)} to ${Math.max(...n)}`; })()}) passes every requirement. That is a property of the cases, the same for every system; what differs is who writes the fix and when the failure is known.`,
    "",
    `On the combined code of the ${conflicts.length} conflict cases, ${(() => {
      const broke = (c, id) => c.combined.some((x) => x.id === id);
      const a = conflicts.filter((c) => broke(c, c.facts.a.id));
      const shared = a.filter((c) => c.facts.a.id === c.facts.b.id);
      const b = conflicts.filter((c) => c.facts.b.id !== c.facts.a.id && broke(c, c.facts.b.id));
      const k = conflicts.filter((c) => c.combined.some((x) => canon.some((f) => f.id === x.id)));
      return `A's claimed fact broke in ${a.length}${shared.length ? ` (in ${shared.map((c) => c.id).join(", ")} it is B's too)` : ""}, B's in ${b.length}, and a canon fact, with the inputs drawn here, in ${k.length} (${k.map((c) => c.id).join(", ")})`;
    })()}. The queue detects every one because it runs the very checks that fail; what it shows is that gating on the same checks catches these combinations whoever runs them. Its weak point is the assumption: a queue that runs only each branch's own tests would not have A's requirement as a protected check when B arrives.`,
    "",
    "## Cases in detail",
    "",
  );
  for (const [i, c] of cs.entries()) {
    const fact = (f) => `${code(f.id)}: "${f.sentence}"`;
    out.push(
      `### ${c.id}`,
      "",
      `**${i + 1}. ${c.title}.** ${c.class}. ${c.kind === "control" ? "Control" : "Conflict"}, deliberately seeded. [case files](../conflicts/cases/${c.id})`,
      "",
      c.story,
      "",
      `- **A** (+${c.size.a.added} −${c.size.a.removed} lines in ${c.a.files.join(", ")}) claims ${fact(c.facts.a)}.`,
      `- **B** (+${c.size.b.added} −${c.size.b.removed} lines in ${c.b.files.join(", ")}) ${c.b.join ? `joins the same fact, ${code(c.b.join)}` : `claims ${fact(c.facts.b)}`}.`,
      `- **git merge**: ${c.merge.clean ? `clean (${c.merge.seconds} s)` : `text conflict in ${c.merge.conflicted.join(", ")}; ${c.merge.repaired}`}.`,
      `- **Together**: ${c.combined.length ? c.combined.map((x) => `breaks ${code(x.id)} ("${sentence(x.id, c)}"): ${x.detail}`).join("; ") : `all ${n + (c.facts.a.id === c.facts.b.id ? 1 : 2)} requirements hold`}.`,
      ...(c.hasResolution ? [`- **Reference resolution** (written by the case author, +${c.size.resolution.added} −${c.size.resolution.removed} lines): ${c.resolution} ${c.resolved.length ? `Still fails ${fails(c.resolved)}.` : "Every requirement holds."}`] : []),
      `- **Local stages**: A on the base ${c.queue.a.seconds} s; B on base+A ${c.queue.b.seconds} s${c.queue.fix ? `; the fix ${c.queue.fix.seconds} s` : ""}.`,
      ...(c.notes.length ? [`- **Re-runs**: ${c.notes.join("; ")}.`] : []),
      ...(c.deviations.length ? [`- **Not as designed**: ${c.deviations.join("; ")}.`] : []),
      ...(d(c) ? [`- **Canon (deployed judge)**: ${d(c).outcome}${d(c).records?.length ? ` (${d(c).records.map((r, k) => `[record ${k + 1}](${r})`).join(", ")})` : ""}.`] : []),
      "",
    );
  }
  out.push(
    "## Canon (deployed judge)",
    "",
    deployed
      ? `${deployed.date ? `Run on ${deployed.date}` : "Run"}${deployed.judge ? ` against judge ${deployed.judge}` : ""}. ${deployed.notes ?? ""}`.trim()
      : "**Placeholder: not run yet.** This column is filled from a run of the same cases on the deployed judge, written to `docs/conflicts/deployed.json` and rendered with `node scripts/conflicts.mjs --render`. The intended setup: one project per case, genesis from `conflicts/app` (`DEMO_DIR=conflicts/app`); A and B each claim the fact in their side of `case.json` (`canon claim --fact <file>`; double-discount's B joins A's fact with `--join`) and push `a.patch` or `b.patch` with plain Git; the owner accepts A, and the judge re-applies B onto the new canon by itself. A fix is an attempt on the new canon with B's change plus `resolution.patch`. In basket-shape and control-basket-shape, A changes the stored basket's shape, which the previous version can't read back, so A's release reports a failed rollback rehearsal: an owner's accept still releases it (and the record says so), autopilot would hold it.",
    "",
    "The file's shape, one entry per case id:",
    "",
    "```json",
    '{ "date": "2026-10-14", "judge": "<Worker version, commit>", "setup": "<how the projects were run>", "notes": "<anything a reader needs>",',
    '  "cases": { "vat-on-list-price": { "outcome": "<what happened, one line>", "reapplied": "clean | conflict, repaired | conflict, handed back",',
    '    "repair": "<what the repair model did, text-conflict cases only>", "detected": true, "delivered": false, "accepted": false,',
    '    "resolved": true, "interventions": 1, "detectSeconds": 70, "resolveSeconds": 95, "records": ["https://…/verdict"] } } }',
    "```",
    "",
    "`detected`: the combined code was rejected; `delivered`: a broken combination became canon or reached production; `accepted` (controls): both changes landed; `repair`: what the judge's repair model made of a text conflict, and whether every fact held on it; `resolved`: a candidate with both changes reached Ready; `interventions`: the actions an agent or a person took to get there.",
    "",
    "## What this does not show",
    "",
    `- These are ${cs.length} designed cases, seeded by Canon's author with known answers, on a small app: evidence that each failure class is caught (and each control accepted) by checks on the combined code, not a measure of how often such conflicts occur or of any system's rate on real work.`,
    "- The local queue is a model with the same checks by construction. Its detection is not an advantage or a disadvantage of Canon; the difference to look for is in who re-applies and repairs, what a person has to do, and the time it takes, which only the deployed run measures.",
    "- The seeded repair (`git merge -X theirs`) stands in for a hurried resolution. It is not Canon's repair model, which may keep both sides.",
    `- One run, fixed seeds. Canon's own facts draw new inputs after every push; \`vat-is-a-quarter\` samples five quantities from 1 to 20, so on the deployed judge it may or may not draw a discounted quantity in the cases where that matters.`,
    "",
  );
  return out.join("\n");
}

const results = args.render ? JSON.parse(readFileSync(RESULTS, "utf8")) : await run();
const deployed = existsSync(DEPLOYED) ? JSON.parse(readFileSync(DEPLOYED, "utf8")) : null;
writeFileSync(REPORT, render(results, deployed));
const off = results.cases.filter((c) => !c.asDesigned);
process.stderr.write(`${results.cases.length} cases, ${off.length ? `${off.length} not as designed: ${off.map((c) => c.id).join(", ")}` : "all as designed"}${args.render ? "" : `; ${results.seconds} s`}. Wrote ${REPORT.replace(ROOT, "")}${args.render ? "" : ` and ${RESULTS.replace(ROOT, "")}`}\n`);
