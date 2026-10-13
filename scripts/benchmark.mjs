// A fair comparison, offline and reproducible: the same attempts, in the same order, through a strong merge queue and
// through Canon, with each Canon mechanism switched off in turn. Both get the same protected checks (every canon fact
// plus the attempt's own, the repo's CI commands), the same conflict repair (3-way re-apply, then the judge's own
// repair model, called as a service), and the same compute (one machine, sequential). "Production" is a local Worker
// with persistent storage that lives across releases and gets user traffic between them, so data problems show up as
// they would for real.
//
//   CANON_KEY=<owner key> node scripts/benchmark.mjs [--workloads data,stateless,integration] [--out docs/benchmark.md]
//
// Measured per system: features safely landed, wrong accepts (a release that broke a fact in production), incidents a
// rollback couldn't fix, releases shipped that couldn't be rolled back safely (found by rehearsing the rollback after
// the fact), unnecessary rejects (a feature Canon landed safely that this system didn't), people needed (conflicts
// nobody could repair, decisions routed to an owner), agent reworks, checks run and seconds spent.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../referee/src/probe.ts";
import { dataChanges, dataFiles } from "../referee/src/evidence.ts";
import { addedText } from "../referee/src/symbols.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const KEY = process.env.CANON_KEY;
const REPAIR_URL = process.env.CANON_REPAIR_URL ?? "https://canon.rodeo/p/rehearse/repair";
const sh = (cwd, cmd) => execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" }).toString();
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
let nextPort = 8820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Workloads --------------------------------------------------------------------------------------------------

const farm = JSON.parse(readFileSync(join(ROOT, "agents/canon.autopilot.json"), "utf8"));
const price = JSON.parse(readFileSync(join(ROOT, "demo-stateless/canon.json"), "utf8"));
const byId = (file, id) => file.backlog.find((f) => f.id === id) ?? file.facts.find((f) => f.id === id);
const FARM_PATCH = join(ROOT, "scripts/load-patches.py");
const PRICE_PATCH = join(ROOT, "scripts/stateless-patches.py");
const WORKLOADS = {
  data: {
    about: "a stateful app (Durable Object storage): correct features, a schema change that only breaks on existing data, a data migration the previous version can't read, and a destructive cleanup",
    app: "demo-app", canon: farm, patcher: FARM_PATCH,
    attempts: [
      ["no-double-booking", "no-double-booking2"], ["stall-hours", "stall-hours-schema"], ["line-limit", "line-limit"],
      ["sold-out-refused", "sold-out-moved"], ["stall-products", "drop-legacy"], ["remove-from-basket", "remove-from-basket2"], ["search-by-name", "search-by-name"],
    ],
    // drop-legacy is claimed as stall-products here but doesn't build it: the claimed fact fails, as a wrong attempt would.
  },
  stateless: {
    about: "a stateless Worker: two correct features and one with an intermittent upstream failure (one request in eight) that every check passes on a retry",
    app: "demo-stateless", canon: price, patcher: PRICE_PATCH,
    attempts: [["bulk-discount", "bulk-discount"], ["quote-has-name", "quote-has-name-flaky"], ["quote-has-name", "quote-has-name"]],
  },
  integration: {
    about: "the integration-under-load workload: 16 attempts cycling over 8 backlog features, each branched from genesis (so most need re-applying onto a canon that moved)",
    app: "demo-app", canon: farm, patcher: FARM_PATCH,
    attempts: Array.from({ length: 16 }, (_, n) => {
      const f = ["line-limit", "sold-out-refused", "search-by-name", "product-page", "stall-products", "no-double-booking", "remove-from-basket", "stall-hours"][n % 8];
      return [f, { "no-double-booking": "no-double-booking2", "remove-from-basket": "remove-from-basket2" }[f] ?? f];
    }),
  },
};

const SYSTEMS = {
  queue: { label: "Strong merge queue", queue: true },
  canon: { label: "Canon" },
  "canon-no-candidate": { label: "Canon without the release candidate (long-lived data)", candidate: false },
  "canon-no-rehearsal": { label: "Canon without rollback rehearsal", rehearsal: false },
  "canon-no-canary": { label: "Canon without the canary", canary: false },
  "canon-no-data-gate": { label: "Canon without the destructive-data gate", dataGate: false },
  "canon-no-repair": { label: "Canon without conflict repair (3-way re-apply only)", repair: false },
};
const PLAN = {
  data: ["queue", "canon", "canon-no-candidate", "canon-no-rehearsal", "canon-no-data-gate"],
  stateless: ["queue", "canon", "canon-no-canary"],
  integration: ["queue", "canon", "canon-no-repair"],
};

// ---- A local app: wrangler dev on a checkout, its storage in a directory (kept for production, fresh for a preview)

async function serve(dir, state) {
  const port = nextPort++;
  const p = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state], { cwd: dir, stdio: "pipe", detached: true });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(url)).status) break;
    } catch {}
    await sleep(500);
  }
  return { url, stop: async () => { try { process.kill(-p.pid); } catch {} await sleep(800); } };
}

function checkout(repo, sha, app) {
  const dir = mkdtempSync(join(tmpdir(), "bench-code-"));
  sh(repo, `git archive ${sha} | tar -x -C ${dir}`);
  symlinkSync(join(ROOT, "demo-app/node_modules"), join(dir, "node_modules"));
  return dir;
}

const probes = (facts) => facts.filter((f) => f.check.kind === "probe");
const commands = (facts) => facts.filter((f) => f.check.kind === "command" && !/sha256sum/.test(f.check.run));
async function factsHold(url, facts, seed, m) {
  for (const f of probes(facts)) {
    m.checks++;
    let r = await runCheck(f.check, url, `${seed}:${f.id}`);
    for (const wait of [1500, 4000]) if (!r.held) { await sleep(wait); r = await runCheck(f.check, url, `${seed}:${f.id}`); }
    if (!r.held) return { held: false, fact: f, detail: r.detail };
  }
  return { held: true };
}
function commandsHold(dir, facts, m) {
  for (const f of commands(facts)) {
    m.checks++;
    try { sh(dir, f.check.run); } catch (e) { return { held: false, fact: f, detail: String(e.stderr || e.stdout || "").trim().split("\n").slice(-1)[0] }; }
  }
  return { held: true };
}
async function rawErrors(url, paths, n) {
  let errors = 0;
  for (let i = 0; i < n; i++) {
    try { const r = await fetch(new URL(paths[i % paths.length], url)); await r.arrayBuffer(); if (r.status >= 500) errors++; } catch { errors++; }
  }
  return errors;
}

// The judge's repair model, as a service: the same capability for both systems.
async function repair(repo, files, intent) {
  if (!KEY) return false;
  for (const path of files) {
    const conflicted = readFileSync(join(repo, path), "utf8");
    const res = await fetch(REPAIR_URL, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ path, conflicted, intents: [intent] }) }).then((r) => r.json()).catch(() => null);
    if (!res?.file) return false;
    writeFileSync(join(repo, path), res.file);
  }
  return true;
}

// ---- One system through one workload ----------------------------------------------------------------------------

async function run(workloadName, systemName) {
  const w = WORKLOADS[workloadName];
  const sys = { candidate: true, rehearsal: true, canary: true, dataGate: true, repair: true, ...SYSTEMS[systemName] };
  const t0 = Date.now();
  const m = { landed: [], landedUnsafe: [], wrongAccepts: [], unrecoverable: 0, unsafeShipped: [], peopleNeeded: [], reworks: [], held: [], checks: 0, releases: 0 };
  const repo = mkdtempSync(join(tmpdir(), "bench-repo-"));
  cpSync(join(ROOT, w.app), repo, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".wrangler") });
  writeFileSync(join(repo, "canon.json"), JSON.stringify({ ...w.canon, backlog: [] }, null, 2));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qm", "genesis");
  const genesis = git(repo, "rev-parse", "HEAD");
  // Every attempt is a branch from genesis with its own change.
  w.attempts.forEach(([, patch], i) => {
    git(repo, "checkout", "-q", "-b", `a${i}`, genesis);
    execFileSync("python3", [w.patcher, repo, patch], { stdio: "pipe" });
    git(repo, "-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qam", `a${i} ${patch}`);
  });
  git(repo, "checkout", "-q", "main");
  const canonFacts = [...w.canon.facts];
  // Production: genesis, live, with users.
  const prodState = mkdtempSync(join(tmpdir(), "bench-prod-"));
  let prodSha = genesis;
  let prodDir = checkout(repo, prodSha);
  let prod = await serve(prodDir, prodState);
  const traffic = async () => { for (const f of probes(canonFacts)) await runCheck(f.check, prod.url, `users:${Math.random()}`).catch(() => null); };
  await traffic();
  // One shopper's basket, kept in production from the start: a release that loses it lost users' data.
  const survivor = { "content-type": "application/json", "x-canon-run": "survivor" };
  const stateful = w.app === "demo-app";
  // After an incident it's put back, so each release is judged on its own (one loss isn't blamed on every later one).
  const seedSurvivor = async () => {
    if (!stateful) return;
    await fetch(new URL("/api/cart", prod.url), { method: "DELETE", headers: survivor }).catch(() => null);
    const now = await fetch(new URL("/api/cart", prod.url), { headers: survivor }).then((r) => r.json()).catch(() => null);
    const have = now?.items?.find?.((x) => x.productId === "eggs")?.qty ?? 0;
    if (have < 3) await fetch(new URL("/api/cart", prod.url), { method: "POST", headers: survivor, body: JSON.stringify({ productId: "eggs", qty: 3 - have }) });
  };
  await seedSurvivor();
  const survived = async () => !stateful || (await fetch(new URL("/api/cart", prod.url), { headers: survivor }).then((r) => r.json()).catch(() => null))?.items?.[0]?.qty === 3;

  for (const [i, [factId, patch]] of w.attempts.entries()) {
    const fact = byId(w.canon, factId);
    const name = `${factId} (${patch})`;
    if (m.landed.includes(factId)) continue; // already true: a later attempt at it has nothing to land
    // Integrate: the attempt's own change, re-applied 3-way onto the current canon; repair what conflicts.
    const before = git(repo, "rev-parse", "HEAD");
    const diff = git(repo, "diff", "--binary", genesis, `a${i}`, "--", ".", ":(exclude)canon.json");
    writeFileSync(join(repo, ".patch"), diff + "\n");
    let applied = true;
    try { git(repo, "apply", "--3way", "--index", ".patch"); } catch {
      const conflicted = git(repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
      applied = conflicted.length > 0 && sys.repair && (await repair(repo, conflicted, fact.sentence));
      if (applied) git(repo, "add", "-A", "--", ...conflicted);
    }
    rmSync(join(repo, ".patch"), { force: true });
    if (!applied) {
      git(repo, "reset", "-q", "--hard", before);
      m.peopleNeeded.push(`${name}: a text conflict nobody could repair`);
      continue;
    }
    git(repo, "-c", "user.name=b", "-c", "user.email=b@b", "commit", "-qm", `land ${name}`, "--allow-empty");
    const sha = git(repo, "rev-parse", "HEAD");
    const reject = (why) => { git(repo, "reset", "-q", "--hard", before); m.reworks.push(`${name}: ${why}`); };
    // The verdict: every canon fact and its own, plus CI, on a fresh copy (a preview, or the queue's CI).
    const code = checkout(repo, sha);
    const cmd = commandsHold(code, [...canonFacts, fact], m);
    if (!cmd.held) { reject(`CI: ${cmd.fact.id}`); continue; }
    const preview = await serve(code, mkdtempSync(join(tmpdir(), "bench-fresh-")));
    const verdict = await factsHold(preview.url, [...canonFacts, fact], `verdict:${i}`, m);
    await preview.stop();
    if (!verdict.held) { reject(`broke ${verdict.fact.id}`); continue; }
    // Canon's data gate: a destructive schema change waits for a person (who, here, accepts it: counted as needed).
    const added = dataFiles(git(repo, "diff", "--name-only", before, sha).split("\n").filter(Boolean)).map((p) => ({ path: p, lines: addedText(sh(repo, `git show ${before}:${p} 2>/dev/null || true`), sh(repo, `git show ${sha}:${p}`)) }));
    const data = dataChanges(added);
    // The owner, shown the destructive line, declines a change that drops a table the app still uses.
    if (!sys.queue && sys.dataGate && data.destructive.length) {
      m.peopleNeeded.push(`${name}: destructive data change, an owner decides (${data.destructive[0]})`);
      git(repo, "reset", "-q", "--hard", before);
      m.held.push(`${name}: the owner declined the destructive change`);
      continue;
    }
    // Release.
    if (!sys.queue) {
      // The release candidate: a copy of production's data, the new code, every fact.
      const candState = mkdtempSync(join(tmpdir(), "bench-cand-"));
      cpSync(prodState, candState, { recursive: true });
      if (sys.candidate) {
        const cand = await serve(code, candState);
        const c = await factsHold(cand.url, [...canonFacts, fact], `candidate:${i}`, m);
        let canaryBad = null;
        if (c.held && sys.canary && w.app === "demo-stateless") {
          // The canary's raw requests (no retries), new version against old, as its 10% step would see them.
          const gets = probes([...canonFacts, fact]).flatMap((f) => f.check.steps.filter((s) => !s.method && !s.path.includes("{{")).map((s) => s.path));
          const [nErr, oErr] = [await rawErrors(cand.url, gets, 40), await rawErrors(prod.url, gets, 40)];
          if ((nErr - oErr) / 40 > 0.05) canaryBad = `${nErr}/40 raw errors against ${oErr}/40`;
        }
        await cand.stop();
        if (!c.held) { m.held.push(`${name}: release candidate broke ${c.fact.id} on production's data`); reject("held back at release"); continue; }
        if (canaryBad) { m.held.push(`${name}: canary: ${canaryBad}`); reject("held back by the canary"); continue; }
      }
      if (sys.rehearsal) {
        // The rollback rehearsal: the code production runs, on the data the new code wrote.
        if (sys.candidate) { const cand = await serve(code, candState); await factsHold(cand.url, [...canonFacts, fact], `write:${i}`, m); await cand.stop(); }
        const old = await serve(prodDir, candState);
        const r = await factsHold(old.url, canonFacts, `rehearse:${i}`, m);
        await old.stop();
        if (!r.held) { m.held.push(`${name}: rollback rehearsal: the previous version broke ${r.fact.id}`); reject("held back: rollback not safe"); continue; }
      }
    }
    // Ship to production: new code on production's data; users come back; production is checked.
    await prod.stop();
    const oldDir = prodDir;
    prodDir = code;
    prodSha = sha;
    prod = await serve(prodDir, prodState);
    m.releases++;
    canonFacts.push(fact);
    let live = await factsHold(prod.url, canonFacts, `prod:${i}`, m);
    if (live.held && !(await survived())) live = { held: false, fact: { id: "a shopper's basket" }, detail: "lost in the release" };
    if (live.held && w.app === "demo-stateless") {
      const gets = probes(canonFacts).flatMap((f) => f.check.steps.filter((s) => !s.method && !s.path.includes("{{")).map((s) => s.path));
      const errs = await rawErrors(prod.url, gets, 60);
      if (errs / 60 > 0.05) live = { held: false, fact: { id: "users' error rate" }, detail: `${errs}/60 requests failed` };
    }
    // After the fact: could this release be rolled back safely? (the old code on a copy of production's data)
    const after = mkdtempSync(join(tmpdir(), "bench-after-"));
    cpSync(prodState, after, { recursive: true });
    const back = await serve(oldDir, after);
    const rollbackOk = (await factsHold(back.url, canonFacts.filter((f) => f !== fact), `after:${i}`, m)).held;
    await back.stop();
    if (!rollbackOk) m.unsafeShipped.push(name);
    const unsafeNow = !rollbackOk;
    if (!live.held) {
      m.wrongAccepts.push(`${name}: broke ${live.fact.id} in production (${String(live.detail).slice(0, 90)})`);
      // Roll back: the previous code, on production's data as it is now.
      await prod.stop();
      prodDir = oldDir;
      prod = await serve(prodDir, prodState);
      canonFacts.pop();
      const restored = await factsHold(prod.url, canonFacts, `restored:${i}`, m);
      // A rollback restores code, not data: a lost basket stays lost.
      if (!restored.held || !(await survived())) m.unrecoverable++;
      await seedSurvivor();
      git(repo, "reset", "-q", "--hard", before);
      continue;
    }
    m.landed.push(factId);
    if (unsafeNow) m.landedUnsafe.push(factId);
    await traffic();
  }
  await prod.stop();
  return { ...m, seconds: Math.round((Date.now() - t0) / 1000) };
}

// ---- Report ------------------------------------------------------------------------------------------------------

const chosen = (args.workloads ?? "data,stateless,integration").split(",");
const results = {};
for (const wl of chosen) {
  results[wl] = {};
  for (const s of PLAN[wl]) {
    process.stderr.write(`${wl} / ${s}…\n`);
    results[wl][s] = await run(wl, s);
  }
}
const lines = [
  "# Benchmark: Canon against a strong merge queue, and Canon with each mechanism switched off",
  "",
  `Generated by \`scripts/benchmark.mjs\` on ${new Date().toISOString().slice(0, 10)}. Every system gets the same attempts in the same order, the same protected checks (every canon fact plus the attempt's own, and the repo's CI), the same conflict repair (3-way re-apply, then the judge's repair model as a service) and the same compute (one machine, sequential, local Workers). Production is a local Worker whose storage persists across releases, with user traffic between them.`,
  "",
  "**Safely landed**: a feature in production at the end, with every fact holding, whose release can be rolled back safely. **Wrong accepts**: a release that broke a fact in production. **Unsafe to roll back**: shipped releases whose previous version, run on production's data afterwards, broke a fact. **Needless rejects**: features Canon landed safely that this system didn't. **People**: conflicts nobody could repair, decisions routed to an owner.",
  "",
];
for (const [wl, bySys] of Object.entries(results)) {
  const safe = (r) => r.landed.filter((f) => !r.landedUnsafe.includes(f));
  const canonLanded = new Set(bySys.canon ? safe(bySys.canon) : []);
  lines.push(`## ${wl}: ${WORKLOADS[wl].about}`, "", "| System | Safely landed | Wrong accepts | Unrecoverable | Unsafe to roll back | Needless rejects | People | Agent reworks | Checks | Seconds |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const [s, r] of Object.entries(bySys)) {
    const needless = [...canonLanded].filter((f) => !r.landed.includes(f)).length;
    lines.push(`| ${SYSTEMS[s].label} | ${safe(r).length} | ${r.wrongAccepts.length} | ${r.unrecoverable} | ${r.unsafeShipped.length} | ${s === "canon" ? "-" : needless} | ${r.peopleNeeded.length} | ${r.reworks.length} | ${r.checks} | ${r.seconds} |`);
  }
  lines.push("");
  for (const [s, r] of Object.entries(bySys)) {
    const notes = [...r.wrongAccepts.map((x) => `wrong accept: ${x}`), ...r.unsafeShipped.map((x) => `shipped, unsafe to roll back: ${x}`), ...r.held.map((x) => `held: ${x}`), ...r.peopleNeeded.map((x) => `person: ${x}`)];
    if (notes.length) lines.push(`- **${SYSTEMS[s].label}**: ${notes.join("; ")}`);
  }
  lines.push("");
}
lines.push("What this doesn't measure: wall-clock with real parallelism (Canon verifies six attempts at once and checks merge trains once; here everything runs in sequence), people's time to review, or many runs with different orders. It is one deterministic replay per workload.");
const out = lines.join("\n") + "\n";
if (args.out) writeFileSync(join(ROOT, args.out), out);
console.log(out);
