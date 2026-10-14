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

// What happened in one case, from the judge's records only: each side judged alone, which landed first, the verdict on
// the combined code, the fix, and the releases. Times are the judge's own timestamps.
async function summarize(r) {
  const c = JSON.parse(readFileSync(join(CASES_DIR, r.id, "case.json"), "utf8"));
  if (r.error || !r.ledger) return { outcome: `not run: ${r.error ?? r.outcome ?? "no records"}`, detected: false, delivered: false, accepted: false, resolved: false, interventions: 0, records: [] };
  const feature = (id) => r.ledger.features.find((f) => f.id === id);
  const ids = [c.a.fact.id, c.b.join ?? c.b.fact.id];
  const attempts = [...new Set(ids)].flatMap((id) => feature(id)?.attempts ?? []);
  const own = (agent) => attempts.filter((a) => a.agent === agent && !a.reappliedFrom).sort((x, y) => (x.judgedAt ?? 0) - (y.judgedAt ?? 0));
  // Each side's first verdict, read from its record: did its own fact hold, and did it break no fact canon when it forked?
  // ("behind" alone says only that a newer fact failed on it: the other side's, landed while it was judged.)
  const alone = await Promise.all(["a", "b"].map(async (side) => {
    const first = own(c[side].agent)[0];
    if (!first) return `${side.toUpperCase()} not judged alone`;
    const v = await fetch(`${URL_}/p/${r.project}/attempts/${first.attempt}/verdict`).then((x) => x.json()).catch(() => null);
    const held = v?.claimed?.held && !(v?.lost ?? []).length;
    return `${side.toUpperCase()} ${held ? "held alone" : "did not hold alone"} (${first.outcome}${first.outcome === "behind" ? ": the other's fact, landed while it was judged, failed on it" : ""})`;
  }));
  const accepts = r.timeline.filter((e) => e.kind === "accept");
  const releases = r.timeline.filter((e) => e.kind === "release" || e.kind === "held");
  const combined = attempts.filter((a) => a.reappliedFrom && ["contradicts", "unproven"].includes(a.outcome)).sort((x, y) => x.judgedAt - y.judgedAt)[0];
  const reappliedOk = attempts.filter((a) => a.reappliedFrom && a.outcome === "ready");
  const fixed = attempts.filter((a) => /\(refreshed onto canon \d+\)$/.test(a.why ?? "") && a.outcome === "ready").sort((x, y) => x.judgedAt - y.judgedAt)[0];
  const bothCanon = ids.every((id) => ["released", "healthy in production", "accepted"].includes(feature(id)?.stage));
  const first = accepts[0];
  const last = releases.at(-1);
  const sec = (a, b) => (a && b ? Math.round((b - a) / 1000) : null);
  const repaired = r.timeline.some((e) => e.kind === "push" && /The judge/.test(e.text)) && attempts.some((a) => a.reappliedFrom);
  const records = [combined && `${URL_}/p/${r.project}/attempts/${combined.attempt}/verdict`, ...accepts.map((e) => e.link && `${URL_}${e.link}`)].filter(Boolean).slice(0, 4);
  const supersededDuplicate = !!c.b.join && attempts.some((a) => a.agent === c.b.agent && a.status === "superseded");
  let outcome;
  if (supersededDuplicate && !combined) outcome = `Both built the same fact; ${first ? "the first Ready one landed and" : ""} the other was superseded, never combined (one implementation per fact)`;
  else if (combined) outcome = `Alone: ${alone.join("; ")}. ${first ? `${first.text.replace(/ accepted by.*$/, "")} landed first; ` : ""}the judge re-applied the other on top and the combined code failed: ${combined.failure?.slice(0, 160)}${combined.diagnosis ? ` (diagnosis: ${combined.diagnosis.kind})` : ""}. ${fixed ? `The scripted fix (the case's reference resolution, pushed as its agent would) held every fact and ${bothCanon ? "both features are canon" : "it is Ready"}.` : "The fix didn't reach Ready."}`;
  else if (bothCanon) outcome = `Alone: ${alone.join("; ")}. Both landed: the judge re-applied the second on the first and every fact held on the combined code${c.kind === "conflict" ? " (not detected: a miss)" : ""}`;
  else outcome = `Alone: ${alone.join("; ")}. ${feature(ids[0])?.stage} / ${feature(ids[1])?.stage}`;
  return {
    outcome,
    reapplied: attempts.some((a) => a.reappliedFrom) ? (repaired ? "re-applied by the judge" : "re-applied by the judge") : "not re-applied",
    detected: !!combined,
    delivered: false,
    accepted: c.kind === "control" ? bothCanon : undefined,
    resolved: !!fixed || (c.kind === "control" && bothCanon),
    interventions: r.detectedOn ? 1 : 0,
    detectSeconds: combined ? sec(first?.at, combined.judgedAt) : null,
    resolveSeconds: combined && fixed ? sec(combined.judgedAt, last?.at) : null,
    releases: releases.map((e) => `${e.kind === "held" ? "held" : "released"}: ${e.text.slice(0, 80)}`),
    records,
  };
}

if (args.summarize !== undefined) {
  const raw = JSON.parse(readFileSync(join(ROOT, "docs/conflicts/deployed-raw.json"), "utf8"));
  const cases = Object.fromEntries(await Promise.all(raw.results.map(async (r) => [r.id, await summarize(r)])));
  const out = {
    date: raw.at.slice(0, 10),
    judge: args.judge ?? "",
    setup: "One project per case on canon.rodeo, genesis from conflicts/app, both features in its backlog on autopilot (no person accepts anything). A and B are scripted agents pushing the case's seeded patches together with plain Git; the judge decides what lands, re-applies the other side on the new canon by itself, and judges the combined code. When that fails, the case's reference resolution is pushed the way an agent fixes it (canon refresh, the fix, git push): the one intervention counted. Run by scripts/conflicts-deployed.mjs.",
    notes: args.notes ?? "",
    cases,
  };
  writeFileSync(join(ROOT, "docs/conflicts/deployed.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(Object.entries(cases).map(([id, x]) => `${id}: ${x.outcome}`).join("\n"));
  process.exit(0);
}

const results = await Promise.all(chosen.map((id, n) => runCase(id, n * 15_000).catch((err) => ({ id, project: short(id), error: String(err.stdout ?? err.message ?? err).slice(0, 400) }))));
writeFileSync(join(ROOT, "docs/conflicts/deployed-raw.json"), JSON.stringify({ at: new Date().toISOString(), work, results }, null, 1));
console.log(`wrote docs/conflicts/deployed-raw.json (${results.length} cases, ${Math.round((Date.now() - t0) / 1000)} s); then: node scripts/conflicts-deployed.mjs --summarize --judge "<version, commit>"`);
