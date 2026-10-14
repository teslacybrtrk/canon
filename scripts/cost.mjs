// The numbers behind docs/cost.md, for one or more projects, from records that already exist:
//   1. the judge's own records, public: GET /p/<project>/stats, /ledger and /canon;
//   2. Cloudflare's Workflow instance records, through scripts/timings.mjs --project, run in this process: its
//      list-price estimate is used as it prints it, and the records it fetched give what it doesn't print (who pushed,
//      repairs, previews, concurrency, latency, failures);
//   3. optionally (--logs), the agents' Claude Code transcripts (`claude -p --output-format stream-json`, which
//      agents/run.sh and agents/autopilot.sh keep in runs/): tokens per model, and Claude Code's own list-price figure.
//
//   source scripts/env.sh && node scripts/cost.mjs --project final [--logs runs/autopilot/agent-1,runs/agent-4-discount]
//
// GET requests only; nothing is written. --since <date> moves the start of the Workflow window for every project
// (default: the project's genesis push). Needs what timings.mjs needs: CLOUDFLARE_ACCOUNT_ID and a token that can read
// Workflows (CLOUDFLARE_API_TOKEN, or the one `wrangler login` saved: run `npx wrangler whoami` in referee/ first, which
// renews it; it lasts about an hour). About three API calls a second: a window reaching back two days (some 1,700
// instances on the account) takes about fifteen minutes; a fresh project, seconds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.project && !args.logs) {
  console.error("usage: node scripts/cost.mjs --project <name>[,<name>...] [--since <date>] [--logs <dir or file>[,...]]   (--logs alone: transcripts only, no network)");
  process.exit(1);
}
const BASE = (process.env.CANON_URL ?? "https://canon.rodeo").replace(/\/$/, "");
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const judge = async (project, path) => {
  const r = await realFetch(`${BASE}/p/${project}/${path}`);
  if (!r.ok) throw new Error(`GET /p/${project}/${path}: ${r.status}`);
  return r.json();
};

// Every Cloudflare API call timings.mjs makes comes through here: GET only, about three a second (the API allows 1,200
// per five minutes), retried when rate-limited, and kept in memory for this run only. Step outputs can carry short-lived
// repo tokens, so none is printed and nothing is written to disk.
const CF = "https://api.cloudflare.com/client/v4/";
const seen = new Map();
let headers = null;
let last = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith(CF)) return realFetch(url, init);
  if ((init.method ?? "GET") !== "GET") throw new Error(`refusing ${init.method} ${u}: this script only reads`);
  headers ??= init.headers;
  for (let attempt = 0; !seen.has(u); attempt++) {
    await sleep(Math.max(0, last + 300 - Date.now()));
    last = Date.now();
    const r = await realFetch(u, { headers: init.headers });
    if ((r.status === 429 || r.status >= 500) && attempt < 5) await sleep(10_000 * 2 ** attempt);
    else seen.set(u, await r.json());
  }
  return Response.json(seen.get(u));
};

// timings.mjs --project, unchanged: its table, parsed. It ends with process.exit, which is caught here.
const TIMINGS = new URL("./timings.mjs", import.meta.url);
const EXIT = Symbol("exit");
let passes = 0;
async function timings(project, since) {
  const saved = { argv: process.argv, exit: process.exit, log: console.log };
  const printed = [];
  process.argv = [saved.argv[0], TIMINGS.pathname, "--project", project, "--since", new Date(since).toISOString(), "--limit", "100000"];
  process.exit = () => {
    throw EXIT;
  };
  console.log = (...a) => printed.push(a.join(" "));
  try {
    await import(`${TIMINGS.href}?pass=${++passes}`); // a new URL each pass, so the module runs again
  } catch (err) {
    if (err !== EXIT) throw err;
  } finally {
    process.argv = saved.argv;
    process.exit = saved.exit;
    console.log = saved.log;
  }
  const rows = {};
  for (const line of printed.join("\n").split("\n")) {
    const m = line.match(/^\| (\w+) \| (\d+) \| (\d+) \| \$([\d.]+) \|$/);
    if (m) rows[m[1]] = { n: +m[2], seconds: +m[3], usd: +m[4] };
    const all = line.match(/^\| \*\*all\*\* \| \| \*\*(\d+)\*\* \| \*\*\$([\d.]+)\*\* \|$/);
    if (all) rows.all = { n: Object.values(rows).reduce((s, r) => s + (r.n ?? 0), 0), seconds: +all[1], usd: +all[2] };
  }
  return rows;
}

// The instance records timings.mjs fetched. It details only complete instances; the others in the window (errored,
// terminated, still running) are fetched here so they can be attributed and reported as left out of its estimate.
function records() {
  const detailed = new Map();
  const listed = new Map();
  for (const [u, j] of seen) {
    if (!j?.success) continue;
    let m = u.match(/\/workflows\/([\w-]+)\/instances\/([^/?]+)$/);
    if (m) detailed.set(`${m[1]}/${m[2]}`, { wf: m[1].replace("canon-", ""), ...j.result, id: m[2] });
    m = u.match(/\/workflows\/([\w-]+)\/instances\?/);
    if (m) for (const i of j.result) listed.set(`${m[1]}/${i.id}`, i);
  }
  return { detailed, listed };
}
async function detailUnfinished(since) {
  const { detailed, listed } = records();
  for (const [key, i] of listed) {
    if (i.status === "complete" || detailed.has(key) || new Date(i.created_on).getTime() < since) continue;
    await fetch(`${CF}accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workflows/${key.split("/")[0]}/instances/${i.id}`, { headers });
  }
}

const ms = (x) => new Date(x).getTime();
const name = (s) => s.name.replace(/-\d+$/, "").replace(/ \d+$/, "").replace(/\d+$/, "#"); // as timings.mjs groups steps
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null); // as timings.mjs
const repoOf = (i) => i.params?.source?.repoName ?? i.params?.repo ?? ""; // as timings.mjs
const stepsOf = (i) => (i.steps ?? []).filter((s) => s.type === "step" && s.start && s.end);
const text = (s) => (typeof s?.output === "string" ? s.output : JSON.stringify(s?.output ?? ""));
const has = (i, step) => stepsOf(i).some((s) => name(s) === step);
const said = (i, step, marker) => stepsOf(i).some((s) => name(s) === step && text(s).includes(marker));
function peak(spans) {
  const edges = spans.flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let now = 0;
  let max = 0;
  for (const [, d] of edges) max = Math.max(max, (now += d));
  return max;
}
// Install start to the end of the instance: the stretch a verification holds a build slot and runs containers.
const building = (i) => {
  const s = stepsOf(i).find((x) => name(x) === "install");
  return s && i.end ? [ms(s.start), ms(i.end)] : null;
};
// Mutants built as previews, from the build step's own report; null when the report can't be read.
function mutants(i) {
  const s = stepsOf(i).find((x) => name(x) === "build mutants");
  if (!s) return 0;
  try {
    const line = String(JSON.parse(text(s)).logs?.stdout ?? "").split("\n").find((l) => l.startsWith("CANON_MUTANTS "));
    return line ? JSON.parse(line.slice("CANON_MUTANTS ".length)).filter((m) => m.preview).length : 0;
  } catch {
    return null;
  }
}

async function measure(p) {
  const [stats, ledger, canon] = await Promise.all([judge(p, "stats"), judge(p, "ledger"), judge(p, "canon")]);
  // Seed facts are written at genesis's first verdict, so the window starts at the genesis push before them: the last
  // push to <project>-genesis that came before (a project reset earlier under the same name stays out). The second
  // timings.mjs pass is answered from memory.
  const genesis = Math.min(...canon.facts.map((f) => f.createdAt).filter(Boolean));
  let since = args.since ? ms(args.since) : genesis - 15 * 60_000;
  let cost = await timings(p, since);
  if (!args.since) {
    const pushes = [...records().detailed.values()].filter((i) => repoOf(i) === `${p}-genesis` && i.queued && ms(i.queued) <= genesis).map((i) => ms(i.queued));
    if (pushes.length) cost = await timings(p, (since = Math.max(...pushes) - 1_000));
  }
  await detailUnfinished(since);
  const all = [...records().detailed.values()];
  // timings.mjs takes every instance whose repo carries the project's name. A repo the judge doesn't know is either a
  // re-apply that conflicted or failed (the judge deletes that attempt; the run was this project's) or work for an
  // earlier project of the same name whose judge was still running after a reset. The latter is reported and left out
  // here; timings.mjs's figure keeps it. Known: the claims' attempts (the latest 200), trains and genesis.
  const named = all.filter((i) => repoOf(i).startsWith(`${p}-`) && ms(i.queued ?? i.start) >= since);
  const known = new Set([`${p}-genesis`, ...canon.claims.map((c) => c.attemptId), ...canon.trains.map((t) => t.id), ...named.filter((i) => i.wf === "train").map(repoOf)]);
  const foreign = named.filter((i) => !known.has(repoOf(i)) && i.wf !== "refresh");
  const mine = named.filter((i) => !foreign.includes(i));
  const of = (wf) => mine.filter((i) => i.wf === wf);
  const [verify, refresh, train, mutate, promote] = ["verify", "refresh", "train", "mutate", "promote"].map(of);

  const releases = new Map();
  for (const f of ledger.features) for (const r of f.releases) releases.set(r.seq, r.release);
  const delivered = ledger.summary.released;

  // Pushes Artifacts delivered (each starts a verify instance): the judge's own come from re-apply and train runs that
  // report a push, and refs/notes/canon (the fact chain); the rest of main's are the agents' (and genesis).
  const events = verify.filter((i) => i.trigger?.source === "event");
  const onMain = events.filter((i) => i.params?.payload?.ref === "refs/heads/main");
  const reapplied = refresh.filter((i) => said(i, "re-apply", "CANON_REFRESH_PUSHED")).length;
  const repairs = refresh.filter((i) => has(i, "repair"));
  const repairFiles = repairs.reduce((n, i) => n + text(stepsOf(i).find((s) => name(s) === "re-apply")).split("CANON_CONFLICT_FILE ").length - 1, 0);
  const repaired = refresh.filter((i) => said(i, "re-apply (repaired)", "CANON_REFRESH_PUSHED")).length;
  const trainPushes = train.filter((i) => said(i, "build train", "CANON_TRAIN_PUSHED")).length;
  const genesisPushes = onMain.filter((i) => repoOf(i) === `${p}-genesis`).length;
  const built = mutate.map(mutants);
  const stepSeconds = (list, step) => list.reduce((n, i) => n + stepsOf(i).filter((s) => name(s) === step).reduce((m, s) => m + (ms(s.end) - ms(s.start)) / 1000, 0), 0);
  // Verify seconds the estimate prices although no container has started: admission (waiting for a build slot) and the
  // checks before it, or the whole instance when it never built (a stale push, a notes push, a refused toolchain).
  const beforeBuild = verify.filter((i) => i.start && i.end).reduce((n, i) => n + ((building(i)?.[0] ?? ms(i.end)) - ms(i.start)) / 1000, 0);
  // Seconds inside container steps (a step that returns a runner result: exit code, logs, snapshot), side-by-side
  // steps counted each; and Workflow steps as Cloudflare counts them for billing (step_count, retries not included).
  const containerSeconds = mine.reduce((n, i) => n + stepsOf(i).filter((s) => text(s).includes('"exitCode"')).reduce((m, s) => m + (ms(s.end) - ms(s.start)) / 1000, 0), 0);
  const workflowSteps = mine.reduce((n, i) => n + (i.step_count ?? (i.steps ?? []).length), 0);

  const judged = verify.filter((i) => has(i, "judge") && i.queued);
  const verdictAt = (i) => ms(stepsOf(i).findLast((s) => name(s) === "judge").end);
  const toVerdict = judged.map((i) => (verdictAt(i) - ms(i.queued)) / 1000);
  const buildToVerdict = judged.filter((i) => building(i)).map((i) => (verdictAt(i) - building(i)[0]) / 1000);
  const runFrom = stats.since ?? genesis;
  const runTo = stats.minutes ? runFrom + stats.minutes * 60_000 : Math.max(...mine.map((i) => ms(i.end ?? i.start)));
  const accountBuilds = all.filter((i) => i.wf === "verify").map(building).filter((b) => b && b[1] > runFrom && b[0] < runTo);
  // The window runs to the last instance, so it includes background work after the run: anything that started after
  // both its last verdict and its last release ended (and its Git notes were pushed).
  const runEnd = Math.max(runTo, ...promote.filter((i) => i.end).map((i) => ms(i.end) + 5_000));
  const after = mine.filter((i) => i.start && i.end && ms(i.start) > runEnd);

  return {
    p, stats, since, delivered, cost,
    window: { to: Math.max(...mine.map((i) => ms(i.end ?? i.start))), after: after.length, afterSeconds: after.reduce((s, i) => s + (ms(i.end) - ms(i.start)) / 1000, 0), afterKinds: [...new Set(after.map((i) => i.wf))].join(", ") },
    releases: { all: releases.size, deployed: [...releases.values()].filter((r) => r === "deployed").length, notReleased: [...releases.values()].filter((r) => r === "not released").length },
    pushes: { events: events.length, agents: onMain.length - reapplied - repaired - trainPushes - genesisPushes, reapplied, repaired, trainPushes, notes: events.filter((i) => i.params?.payload?.ref === "refs/notes/canon").length, genesis: genesisPushes, judgeStarted: verify.length - events.length },
    repos: stats.attempts + train.length + 1 + refresh.filter((i) => !said(i, "re-apply", "CANON_REFRESH_PUSHED") && !said(i, "re-apply (repaired)", "CANON_REFRESH_PUSHED")).length,
    previews: { verify: verify.reduce((n, i) => n + stepsOf(i).filter((s) => name(s).startsWith("preview")).length, 0), mutants: built.reduce((n, x) => n + (x ?? 0), 0), unreadable: built.filter((x) => x === null).length },
    repair: { conflicts: refresh.filter((i) => said(i, "re-apply", "CANON_REFRESH_CONFLICT")).length, sent: repairs.length, files: repairFiles, resolved: refresh.filter((i) => has(i, "re-apply (repaired)")).length, pushed: repaired, seconds: stepSeconds(refresh, "repair") },
    beforeBuild, containerSeconds, workflowSteps,
    release: { candidates: promote.filter((i) => has(i, "deploy release candidate")).length, rehearsals: promote.filter((i) => has(i, "rehearse rollback")).length, gates: promote.filter((i) => has(i, "release gate")).length, notes: promote.filter((i) => has(i, "write notes")).length },
    concurrency: {
      inFlight: peak(verify.filter((i) => has(i, "slot") || has(i, "install")).map((i) => [ms(i.start), ms(i.end)])),
      building: peak(verify.map(building).filter(Boolean)),
      account: peak(accountBuilds),
      instances: peak(mine.filter((i) => i.start && i.end).map((i) => [ms(i.start), ms(i.end)])),
    },
    latency: { n: toVerdict.length, median: q(toVerdict, 0.5), p90: q(toVerdict, 0.9), buildN: buildToVerdict.length, buildMedian: q(buildToVerdict, 0.5), buildP90: q(buildToVerdict, 0.9) },
    failed: {
      unfinished: mine.filter((i) => i.status !== "complete").map((i) => `${i.wf} ${i.status}`),
      foreign: { n: foreign.length, seconds: foreign.filter((i) => i.start && i.end).reduce((s, i) => s + (ms(i.end) - ms(i.start)) / 1000, 0) },
      retries: mine.reduce((n, i) => n + stepsOf(i).filter((s) => /\(retry \d+\)/.test(s.name)).length + stepsOf(i).reduce((m, s) => m + Math.max(0, (s.attempts?.length ?? 1) - 1), 0), 0),
      couldNotJudge: verify.filter((i) => has(i, "could not judge")).length,
      buildFailed: verify.filter((i) => has(i, "build failed") || has(i, "toolchain refused")).length,
      stale: verify.filter((i) => said(i, "slot", "stale")).length,
      superseded: verify.filter((i) => said(i, "still current", "true")).length,
    },
  };
}

// Claude Code's own record of a session: the result line (tokens per model, its list-price figure), or, for a session
// stopped before it wrote one, the usage of each assistant message.
function transcripts(paths) {
  const files = paths.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.(log|jsonl)$/.test(f)).map((f) => join(p, f)) : [p]));
  return files.map((file) => {
    let result = null;
    const messages = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "result") result = e;
      if (e.type === "assistant" && e.message?.id && e.message.usage) messages.set(e.message.id, e.message);
    }
    const usage = {};
    if (result?.modelUsage) for (const [m, u] of Object.entries(result.modelUsage)) usage[m] = { input: u.inputTokens, write: u.cacheCreationInputTokens, read: u.cacheReadInputTokens, output: u.outputTokens };
    else
      for (const m of messages.values()) {
        const u = (usage[m.model] ??= { input: 0, write: 0, read: 0, output: 0 });
        u.input += m.usage.input_tokens ?? 0;
        u.write += m.usage.cache_creation_input_tokens ?? 0;
        u.read += m.usage.cache_read_input_tokens ?? 0;
        u.output += m.usage.output_tokens ?? 0;
      }
    const outcome = result ? `${result.subtype}${result.terminal_reason && result.terminal_reason !== "completed" ? ` (${result.terminal_reason})` : ""}` : "stopped before its result line";
    return { file: relative(ROOT, file) || file, usage, usd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null, minutes: result?.duration_ms ? result.duration_ms / 60_000 : null, outcome };
  });
}

const n = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const table = (title, head, rows, note) => console.log([`## ${title}`, "", ...(note ? [note, ""] : []), `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""].join("\n"));

const results = [];
for (const p of args.project ? args.project.split(",") : []) results.push(await measure(p));

console.log(`# Cost and scale figures\n\nGenerated by \`scripts/cost.mjs\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC${results.length ? ` from ${BASE} (judge records) and Cloudflare's Workflow instance records` : ""}.\n`);
if (results.length) report(results);

function report(results) {
  table("Judge records (/stats, /ledger)", ["Project", "Agents", "Delivered changes", "Releases: shipped / not released", "Pushes", "Verdicts", "Fact checks", "Per delivered change", "Per verdict", "Re-applied by the judge", "Rejected", "Mutation runs", "Trains landed (riders)", "Push to verdict, median / p90 s", "First claim to last verdict, min"],
    results.map((r) => [r.p, r.stats.agents, r.delivered, `${r.releases.deployed} / ${r.releases.notReleased}`, r.stats.pushes, r.stats.verdicts, n(r.stats.checksRun), r.delivered ? n(r.stats.checksRun / r.delivered) : "n/a", n(r.stats.checksRun / Math.max(1, r.stats.verdicts), 1), r.stats.reappliedByJudge, r.stats.rejected, r.stats.mutationRuns, `${r.stats.trainsLanded} (${r.stats.factsByTrain})`, `${r.stats.medianSecondsToVerdict} / ${r.stats.p90SecondsToVerdict}`, n(r.stats.minutes, 1)]),
    "Delivered: a requested fact released to production and still there (the ledger's released). Fact checks: one row per fact per verified commit in the judge's results table.");
  const cell = (c) => (c ? `${c.n} / ${n(c.seconds)} s` : "0");
  const at = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  table("Workflow instance time and list-price estimate (scripts/timings.mjs --project)", ["Project", "Window (UTC)", "verify", "mutate", "refresh", "train", "promote", "All", "List price (USD)", "Per delivered change", "verify seconds before any container", "Seconds in container steps", "Workflow steps", "After the run (background)"],
    results.map((r) => [r.p, `${at(r.since)} to ${at(r.window.to)}`, cell(r.cost.verify), cell(r.cost.mutate), cell(r.cost.refresh), cell(r.cost.train), cell(r.cost.promote), cell(r.cost.all), `$${n(r.cost.all?.usd, 3)}`, r.delivered ? `$${n(r.cost.all?.usd / r.delivered, 3)}` : "n/a", n(r.beforeBuild), n(r.containerSeconds), n(r.workflowSteps), r.window.after ? `${r.window.after} / ${n(r.window.afterSeconds)} s (${r.window.afterKinds})` : "0"]),
    "Instances / seconds of instance wall time (complete instances only), each second priced as a fully busy standard-4 container at list price.");
  table("Concurrency and latency (Workflow records)", ["Project", "Verifications in flight, peak", "Building at once, peak (project)", "Building at once, peak (account, during the run)", "Workflow instances at once, peak", "Push event to verdict, median / p90 s (n)", "Install to verdict, median / p90 s (n)"],
    results.map((r) => [r.p, r.concurrency.inFlight, r.concurrency.building, r.concurrency.account, r.concurrency.instances, `${n(r.latency.median)} / ${n(r.latency.p90)} (${r.latency.n})`, `${n(r.latency.buildMedian)} / ${n(r.latency.buildP90)} (${r.latency.buildN})`]),
    "Building: from a verification's install step to its end. The judge admits at most 6 per project (since Oct 12, 17:44 UTC; no limit before 17:14) and 12 per account (since Oct 13, 05:41 UTC).");
  table("Artifacts and previews", ["Project", "Repos created (genesis, attempts, trains, deleted re-applies)", "Push events", "by agents", "judge re-applies (repaired)", "judge trains", "judge notes", "genesis", "Verifications the judge started without a push", "Preview uploads (verify)", "Mutant previews"],
    results.map((r) => [r.p, r.repos, r.pushes.events, r.pushes.agents, `${r.pushes.reapplied + r.pushes.repaired} (${r.pushes.repaired})`, r.pushes.trainPushes, r.pushes.notes, r.pushes.genesis, r.pushes.judgeStarted, r.previews.verify, `${r.previews.mutants}${r.previews.unreadable ? ` (+${r.previews.unreadable} runs unreadable)` : ""}`]),
    "Artifacts reads (the judge's readFile/log calls, clones and fetches by agents and containers) and tokens minted are not recorded anywhere, so they are not counted.");
  table("Model calls by the judge (Workers AI)", ["Project", "Reviews done / unavailable", "Reviewer passes on done reviews", "Re-apply conflicts", "Sent to repair (files)", "Resolved", "Repaired re-applies pushed", "Seconds waiting on the repair model"],
    results.map((r) => [r.p, `${r.stats.reviewer.reviews} / ${r.stats.reviewer.unavailable}`, Object.values(r.stats.reviewer.bySpecialist ?? {}).reduce((s, t) => s + t.reviews, 0), r.repair.conflicts, `${r.repair.sent} (${r.repair.files})`, r.repair.resolved, r.repair.pushed, n(r.repair.seconds)]),
    "One model call per reviewer pass and per conflicted file, plus retries when Workers AI is out of capacity (not recorded). Token counts are not recorded.");
  table("Release work (promote instances)", ["Project", "Release candidates deployed", "Rollback rehearsals", "Release gates (0% then rollout)", "Git notes written"],
    results.map((r) => [r.p, r.release.candidates, r.release.rehearsals, r.release.gates, r.release.notes]));
  table("Failed and excluded work", ["Project", "Instances not complete (left out of the estimate)", "Earlier project of the same name (in the estimate, not counted here)", "Platform retries (steps)", "Could not judge", "Build failed or toolchain refused", "Pushes dropped as stale", "Stopped mid-build (newer push)"],
    results.map((r) => [r.p, r.failed.unfinished.length ? r.failed.unfinished.join(", ") : 0, r.failed.foreign.n ? `${r.failed.foreign.n} / ${n(r.failed.foreign.seconds)} s` : 0, r.failed.retries, r.failed.couldNotJudge, r.failed.buildFailed, r.failed.stale, r.failed.superseded]));
}

if (args.logs) {
  const rows = [];
  const total = { input: 0, write: 0, read: 0, output: 0, usd: 0 };
  for (const t of transcripts(args.logs.split(","))) {
    for (const [model, u] of Object.entries(t.usage)) {
      rows.push([t.file, model, t.outcome, n(t.turns), n(t.minutes, 1), n(u.input), n(u.write), n(u.read), n(u.output), Object.keys(t.usage).length === 1 ? (t.usd === null ? "n/a" : `$${n(t.usd, 2)}`) : "(see total)"]);
      for (const k of ["input", "write", "read", "output"]) total[k] += u[k];
    }
    total.usd += t.usd ?? 0;
  }
  rows.push(["**all**", "", "", "", "", n(total.input), n(total.write), n(total.read), n(total.output), `$${n(total.usd, 2)}`]);
  table("Agents (Claude Code transcripts)", ["Transcript", "Model", "Outcome", "Turns", "Minutes", "Input tokens", "Cache write", "Cache read", "Output tokens", "Claude Code's list-price figure"], rows,
    "Claude Code's figure prices the tokens at Anthropic's API list prices; it is not a bill (the agents ran on a Claude plan).");
}
