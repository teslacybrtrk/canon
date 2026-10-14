// The seeded conflict cases (conflicts/cases, see docs/conflicts.md) through deployed Canon. Each case gets a project of
// its own on the judge: the base app as genesis, both features in the backlog, autopilot (no person accepts anything).
// The two changes are pushed together by scripted agents (agent-a, agent-b; the patches were written in advance by the
// case author and are labelled seeded), and the judge decides. When the combined code fails, the case's reference
// resolution is pushed the way an agent would fix it (canon refresh, the fix, git push): one intervention, counted.
// Everything is read back from the judge's own records into docs/conflicts/deployed.json; render the report with
// `node scripts/conflicts.mjs --render`.
//
//   source scripts/env.sh && node scripts/conflicts-deployed.mjs [--cases id,id] [--prefix cs]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const URL_ = process.env.CANON_URL;
const sh = (cmd, env = {}, cwd = ROOT) => execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();
const keychain = (name) => sh(`source scripts/env.sh >/dev/null 2>&1; keychain ${name}`).trim();
const OWNER = keychain("canon-owner-key");
const AGENT = keychain("canon-agent-key");
if (!URL_ || !OWNER || !AGENT) throw new Error("source scripts/env.sh first, with both keys in the Keychain (scripts/keys.sh)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES_DIR = join(ROOT, "conflicts/cases");
const base = JSON.parse(readFileSync(join(ROOT, "conflicts/app/canon.json"), "utf8"));
const chosen = (args.cases ? String(args.cases).split(",") : readdirSync(CASES_DIR)).filter((id) => existsSync(join(CASES_DIR, id, "case.json")));
const short = (id) => (args.prefix ?? "cs") + id.replace(/^control-/, "ctl").replace(/[^a-z]/g, "").slice(0, 14);
const work = mkdtempSync(join(tmpdir(), "canon-conflicts-"));
const t0 = Date.now();
const log = (p, line) => process.stderr.write(`${Math.round((Date.now() - t0) / 1000)}s ${p}: ${line}\n`);

async function get(project, path) {
  const r = await fetch(`${URL_}/p/${project}${path}`, { headers: { authorization: `Bearer ${OWNER}` } });
  return r.ok ? r.json() : null;
}
const cli = (project, agent, dir, cmd) => sh(`canon ${cmd}`, { PATH: `${ROOT}cli:${process.env.PATH}`, CANON_PROJECT: project, CANON_KEY: AGENT, CANON_AGENT: agent, CANON_WORKDIR: dir }, dir);
// The CLI says where it put an attempt: "cloned to <dir>" on a claim, "New attempt <id> at <dir>." on a refresh.
const placed = (output) => output.match(/cloned to (\S+)/)?.[1] ?? output.match(/New attempt \S+ at (\S+?)\. /)?.[1];

// One side: claim (or join) its fact, apply its patch, commit, push with plain Git. Returns the attempt's directory.
function pushSide(project, c, side) {
  const s = c[side];
  const dir = join(work, project, s.agent);
  mkdirSync(dir, { recursive: true });
  const at = placed(cli(project, s.agent, dir, `claim --join ${s.join ?? s.fact.id} --why ${JSON.stringify(s.why)}`));
  if (!at) throw new Error(`${project}: the claim didn't say where the attempt is`);
  sh(`git apply ${join(CASES_DIR, c.id, `${side}.patch`)}`, {}, at);
  sh(`git add -A && git -c user.name=${s.agent} -c user.email=${s.agent}@canon.local commit -qm ${JSON.stringify(`${s.why} (seeded patch)`)} && git push -q origin main`, {}, at);
  return at;
}

async function runCase(id, offset) {
  await sleep(offset);
  const c = JSON.parse(readFileSync(join(CASES_DIR, id, "case.json"), "utf8"));
  const project = short(id);
  const out = { id, project, kind: c.kind, events: [] };
  const facts = [c.a.fact, ...(c.b.join ? [] : [c.b.fact])];
  const canonFile = join(work, `${project}.json`);
  writeFileSync(canonFile, JSON.stringify({ ...base, backlog: facts, policy: { autoAccept: "backlog", batch: false } }, null, 2));
  log(project, `genesis (${id})`);
  sh(`./scripts/genesis.sh`, { CANON_PROJECT: project, CANON_FILE: canonFile, DEMO_DIR: "conflicts/app", CANON_KEY: OWNER, CANON_PUBLIC: "1" });
  for (let i = 0; i < 60 && !(await get(project, "/canon"))?.canon; i++) await sleep(10_000);
  if (!(await get(project, "/canon"))?.canon) return { ...out, outcome: "genesis never became canon" };
  log(project, "genesis is canon; pushing A and B together");
  const dirs = { a: pushSide(project, c, "a"), b: pushSide(project, c, "b") };
  const factOf = { a: c.a.fact.id, b: c.b.join ?? c.b.fact.id };

  // Wait for the outcome: a verdict on combined code that fails (detected), both facts canon (accepted), or a stall.
  let detected = null;
  let state;
  for (let i = 0; i < 120; i++) {
    state = await get(project, "/canon");
    const canonIds = new Set((state?.facts ?? []).filter((f) => f.status === "canon").map((f) => f.id));
    const combined = (state?.claims ?? []).find((cl) => cl.refreshedFrom && cl.verdict && ["contradicts", "unproven"].includes(cl.verdict.outcome));
    const handedBack = (state?.claims ?? []).find((cl) => /conflict/.test(cl.refresh ?? ""));
    if (combined) { detected = { claim: combined, how: "combined code failed" }; break; }
    if (handedBack) { detected = { claim: handedBack, how: "text conflict handed back" }; break; }
    if (canonIds.has(factOf.a) && canonIds.has(factOf.b)) break;
    if (c.b.join && canonIds.has(factOf.a) && (state?.claims ?? []).some((cl) => cl.agent === "agent-b" && cl.status === "superseded")) break;
    await sleep(10_000);
  }
  if (detected) {
    const side = detected.claim.agent === "agent-a" ? "a" : "b";
    log(project, `detected: ${detected.how} on ${detected.claim.agent} (${detected.claim.verdict?.outcome ?? detected.claim.refresh}); pushing the reference resolution`);
    out.detectedOn = side;
    // The fix, the way an agent makes it: a fresh attempt on the current canon with its change, then the fix on top.
    let refreshed = "";
    try { refreshed = cli(project, c[side].agent, dirs[side], "refresh"); } catch (e) { refreshed = String(e.stdout ?? "") + String(e.stderr ?? ""); }
    const at = placed(refreshed);
    if (!at) return { ...out, outcome: `refresh failed: ${refreshed.slice(0, 200)}`, timeline: (await get(project, "/timeline"))?.events ?? [] };
    if (/conflict/.test(refreshed)) {
      // A text conflict on the client too: keep this side's lines (the seeded hurried resolution), then the real fix.
      sh(`for f in $(git diff --name-only --diff-filter=U); do git checkout --theirs -- "$f" && git add "$f"; done`, {}, at);
    }
    sh(`git apply --3way ${join(CASES_DIR, id, "resolution.patch")} || git apply ${join(CASES_DIR, id, "resolution.patch")}`, {}, at);
    sh(`git add -A && git -c user.name=${c[side].agent} -c user.email=${c[side].agent}@canon.local commit -qm "fix: both requirements hold together (the case's reference resolution)" && git push -q origin main`, {}, at);
    out.repairPushedAt = Date.now();
    for (let i = 0; i < 120; i++) {
      state = await get(project, "/canon");
      const canonIds = new Set((state?.facts ?? []).filter((f) => f.status === "canon").map((f) => f.id));
      if (canonIds.has(factOf.a) && canonIds.has(factOf.b)) break;
      await sleep(10_000);
    }
  }
  // Releases finish after canon moves: wait for every canon to be released (or held), then read the records back.
  for (let i = 0; i < 60; i++) {
    const l = await get(project, "/ledger");
    if (l && !l.features.some((f) => f.releases.some((r) => r.release === "in progress"))) break;
    await sleep(10_000);
  }
  out.timeline = (await get(project, "/timeline"))?.events ?? [];
  out.ledger = await get(project, "/ledger");
  log(project, "done");
  return out;
}

const results = await Promise.all(chosen.map((id, n) => runCase(id, n * 15_000).catch((err) => ({ id, project: short(id), error: String(err.stdout ?? err.message ?? err).slice(0, 400) }))));
writeFileSync(join(ROOT, "docs/conflicts/deployed-raw.json"), JSON.stringify({ at: new Date().toISOString(), work, results }, null, 1));
console.log(`wrote docs/conflicts/deployed-raw.json (${results.length} cases, ${Math.round((Date.now() - t0) / 1000)} s)`);
