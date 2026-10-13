// Where the time goes on the delivery path, from the platform's own records: every step of every verify and release
// Workflow instance (Cloudflare's start and end times, not the judge's), grouped by step. Active time (a step running)
// is kept apart from waiting (queued before the instance started, and gaps between steps), and the critical path of a
// verdict (push to judge) apart from background work.
//
//   source scripts/env.sh && node scripts/timings.mjs [--since 2026-10-12] [--limit 300] [--out docs/timings.md]
//
// Needs a Cloudflare token that can read Workflows: CLOUDFLARE_API_TOKEN, or the one `wrangler login` saved.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const since = new Date(args.since ?? Date.now() - 2 * 86_400_000).getTime();
const limit = Number(args.limit ?? 300);
function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  for (const p of [join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), join(homedir(), ".config/.wrangler/config/default.toml"), join(homedir(), ".wrangler/config/default.toml")]) {
    if (existsSync(p)) {
      const m = readFileSync(p, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    }
  }
  throw new Error("no Cloudflare token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`");
}
if (!ACCOUNT) throw new Error("CLOUDFLARE_ACCOUNT_ID is unset (source scripts/env.sh first)");
const TOKEN = token();
const api = async (path) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workflows/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j;
};

async function instances(workflow) {
  const out = [];
  let cursor = "";
  while (out.length < limit) {
    const j = await api(`${workflow}/instances?per_page=50${cursor ? `&cursor=${cursor}` : ""}`);
    const page = j.result.filter((i) => new Date(i.created_on).getTime() >= since && i.status === "complete");
    out.push(...page);
    if (!j.result_info?.cursor || j.result.length < 50 || j.result.some((i) => new Date(i.created_on).getTime() < since)) break;
    cursor = j.result_info.cursor;
  }
  const detailed = [];
  for (const i of out.slice(0, limit)) detailed.push({ id: i.id, ...(await api(`${workflow}/instances/${i.id}`)).result });
  return detailed;
}

const ms = (a, b) => new Date(b).getTime() - new Date(a).getTime();
const name = (s) => s.name.replace(/-\d+$/, "").replace(/ \d+$/, "").replace(/\d+$/, "#");
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
const sec = (x) => (x / 1000).toFixed(x < 10_000 ? 1 : 0);

function summarize(list) {
  const steps = new Map();
  let active = 0, waited = 0, gaps = 0, wall = 0;
  for (const inst of list) {
    if (!inst.start || !inst.end) continue;
    waited += Math.max(0, ms(inst.queued, inst.start));
    wall += ms(inst.start, inst.end);
    let prevEnd = inst.start;
    for (const s of inst.steps ?? []) {
      if (s.type !== "step" || !s.start || !s.end) continue;
      const d = ms(s.start, s.end);
      active += d;
      gaps += Math.max(0, ms(prevEnd, s.start));
      prevEnd = s.end;
      const k = name(s);
      if (!steps.has(k)) steps.set(k, { runs: 0, durations: [], retries: 0 });
      const e = steps.get(k);
      e.runs++;
      e.durations.push(d);
      e.retries += Math.max(0, (s.attempts?.length ?? 1) - 1);
    }
  }
  return { n: list.length, steps, active, waited, gaps, wall };
}

function table(title, about, s) {
  const rows = [...s.steps.entries()].map(([k, e]) => ({ k, ...e, total: e.durations.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
  const lines = [`## ${title} (${s.n} instances)`, "", about, "",
    `Wall time ${sec(s.wall)} s in all; steps running ${sec(s.active)} s (${Math.round((100 * s.active) / Math.max(1, s.wall))}%), between steps ${sec(s.gaps)} s; queued before starting ${sec(s.waited)} s.`, "",
    "| Step | Runs | Median s | p90 s | Total s | Share of active time | Retries |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.k} | ${r.runs} | ${sec(q(r.durations, 0.5))} | ${sec(q(r.durations, 0.9))} | ${sec(r.total)} | ${Math.round((100 * r.total) / Math.max(1, s.active))}% | ${r.retries} |`);
  return lines.join("\n");
}

// Build to verdict: from the start of the install to the end of the judge step, per verification (admission waits and
// platform retries before the install are left out: they're queueing, not the path's own work). --split <ISO time>
// compares instances that started before and after a change.
function buildToVerdict(list, split) {
  const span = (inst) => {
    const st = (inst.steps ?? []).filter((s) => s.type === "step" && s.start && s.end);
    const install = st.find((s) => name(s) === "install");
    const judge = st.find((s) => name(s) === "judge");
    return install && judge ? ms(install.start, judge.end) : null;
  };
  const rows = list.map((i) => ({ at: new Date(i.start ?? i.queued).getTime(), d: span(i) })).filter((r) => r.d !== null);
  const line = (label, xs) => `| ${label} | ${xs.length} | ${sec(q(xs, 0.5))} | ${sec(q(xs, 0.9))} |`;
  const out = ["| Verifications | n | Median s | p90 s |", "|---|---|---|---|"];
  if (split) {
    out.push(line(`before ${new Date(split).toISOString().slice(0, 16).replace("T", " ")} UTC`, rows.filter((r) => r.at < split).map((r) => r.d)));
    out.push(line("after", rows.filter((r) => r.at >= split).map((r) => r.d)));
  } else out.push(line("all", rows.map((r) => r.d)));
  return out.join("\n");
}
// --project <name>: the total for one project's delivery instead (every Workflow instance whose repo is one of its
// attempts or trains), priced the way the judge prices its own compute: each second a fully busy standard-4 container
// (4 vCPU, 12 GiB, 20 GB disk) at list price. Durations are instance wall time, so waiting inside an instance counts.
if (args.project) {
  const PER_SECOND = 4 * 0.00002 + 12 * 0.0000025 + 20 * 0.00000007;
  const repoOf = (i) => i.params?.source?.repoName ?? i.params?.repo ?? "";
  const rows = [];
  let total = 0;
  for (const wf of ["canon-verify", "canon-mutate", "canon-refresh", "canon-train", "canon-promote"]) {
    const list = (await instances(wf)).filter((i) => repoOf(i).startsWith(`${args.project}-`) && i.start && i.end);
    const secs = list.reduce((a, i) => a + ms(i.start, i.end) / 1000, 0);
    total += secs;
    rows.push(`| ${wf.replace("canon-", "")} | ${list.length} | ${Math.round(secs)} | $${(secs * PER_SECOND).toFixed(3)} |`);
  }
  const out = [`| Workflow | Instances | Seconds | Cost at list price |`, "|---|---|---|---|", ...rows, `| **all** | | **${Math.round(total)}** | **$${(total * PER_SECOND).toFixed(3)}** |`].join("\n");
  console.log(out);
  process.exit(0);
}
const verifyList = await instances("canon-verify");
const verify = summarize(verifyList);
const split = args.split ? new Date(args.split).getTime() : null;
const promote = summarize(await instances("canon-promote"));
const mutate = summarize(await instances("canon-mutate"));
const out = [
  "# Where the time goes",
  "",
  `Generated by \`scripts/timings.mjs\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from Cloudflare's own Workflows records (instances completed since ${new Date(since).toISOString().slice(0, 10)}, up to ${limit} per workflow, all projects on canon.rodeo). Durations are the platform's step start and end times.`,
  "",
  table("Verification: push to verdict (the critical path an agent waits on)", "A container installs dependencies (from a cache keyed by the lockfile when it can), uploads a Workers Preview, runs the command facts, then the judge runs the probes on the preview.", verify),
  "",
  "Build to verdict (install start to judge end, per verification):",
  "",
  buildToVerdict(verifyList, split),
  "",
  table("Release: accept to production", "Release candidate, rollback rehearsal, version upload, then the judge's 0% gate and gradual rollout. Fixed settle waits (Durable Objects pick up new code eventually) are inside the check steps.", promote),
  "",
  table("Deliberate breaks (background: never on an agent's critical path)", "Up to eight mutants per Ready change, each its own preview.", mutate),
  "",
].join("\n");
if (args.out) writeFileSync(join(ROOT, args.out), out);
console.log(out);
