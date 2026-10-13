// The end-to-end run on deployed Canon: a fresh project on the real judge (Durable Object), Workflows, Artifacts forks,
// Workers Previews, the persistent release candidate, merge trains, the release fence and the gradual rollout. Five
// agents' attempts arrive together: two build the same feature differently (a duplicate), one needs another first (a
// prerequisite, declared with --after), and several change the same lines. Nobody clicks: the project is on autopilot
// for its backlog. What happened is read back from the judge's own records and written to docs/e2e.md.
//
//   source scripts/env.sh && node scripts/e2e.mjs [--project relay] [--out docs/e2e.md]
//
// The project is left up afterwards, so every record the report links to can be inspected.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const PROJECT = args.project ?? "relay";
const URL_ = process.env.CANON_URL;
const sh = (cmd, env = {}, cwd = ROOT) => execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();
const keychain = (name) => sh(`source scripts/env.sh >/dev/null 2>&1; keychain ${name}`).trim();
const OWNER = keychain("canon-owner-key");
const AGENT = keychain("canon-agent-key");
if (!URL_ || !OWNER || !AGENT) throw new Error("source scripts/env.sh first, with both keys in the Keychain (scripts/keys.sh)");
const get = async (path) => (await fetch(`${URL_}/p/${PROJECT}${path}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const log = [];
const note = (line) => { log.push(`${at()} ${line}`); process.stderr.write(`${at()} ${line}\n`); };

// ---- The project: the stateless Worker, a backlog of four facts, autopilot for the backlog, merge trains, a canary.
const stateless = JSON.parse(readFileSync(join(ROOT, "demo-stateless/canon.json"), "utf8"));
const ITEM_PAGE = { id: "item-page", sentence: "Each item has its own API page", check: { kind: "probe", isolate: false, steps: [{ path: "/api/items/honey", expect: { status: 200, json: { id: "honey", cents: 1200 } } }, { path: "/api/items/turnip", expect: { status: 404 } }] } };
const ITEM_LINK = { id: "item-link", sentence: "A quote links to its item's page", check: { kind: "probe", isolate: false, steps: [{ path: "/api/quote?item=kale&qty=1", expect: { status: 200, json: { item: "/api/items/kale" } } }, { path: "/api/items/kale", expect: { status: 200, json: { id: "kale" } } }] } };
const canonFile = {
  ...stateless,
  backlog: [...stateless.backlog.filter((f) => ["bulk-discount", "quote-has-name"].includes(f.id)), ITEM_PAGE, ITEM_LINK],
  policy: { autoAccept: "backlog", batch: true, canary: { steps: [10, 50], holdSeconds: 30 } },
  production: `https://${PROJECT}.canon-rodeo.workers.dev`,
};
const work = mkdtempSync(join(tmpdir(), "canon-e2e-"));
writeFileSync(join(work, "canon.json"), JSON.stringify(canonFile, null, 2));
const revision = sh("git rev-parse --short=12 HEAD").trim();

const existing = await get("/canon").catch(() => null);
if (existing?.canon) note(`project ${PROJECT} already has canon #${existing.canon.seq}; reusing it`);
else {
  note(`genesis of ${PROJECT}`);
  sh(`./scripts/genesis.sh`, { CANON_PROJECT: PROJECT, CANON_FILE: join(work, "canon.json"), DEMO_DIR: "demo-stateless", CANON_KEY: OWNER });
  for (let i = 0; i < 90; i++) {
    const s = await get("/canon").catch(() => null);
    if (s?.canon) break;
    await sleep(10_000);
  }
  note("genesis is canon");
}

// ---- Five attempts, arriving together.
const ATTEMPTS = [
  { agent: "agent-1", fact: "item-link", patch: "item-link", after: "item-page", why: "link each quote to its item page" },
  { agent: "agent-2", fact: "quote-has-name", patch: "quote-has-name", why: "name the item in a quote" },
  { agent: "agent-3", fact: "quote-has-name", patch: "quote-has-name-alt", why: "name the item in a quote (my own take)" },
  { agent: "agent-4", fact: "item-page", patch: "item-page", why: "a page per item" },
  { agent: "agent-5", fact: "bulk-discount", patch: "bulk-discount", why: "10% off ten or more" },
];
const cli = (dir, a, cmd) => sh(`node ${join(ROOT, "cli/canon.mjs")} ${cmd}`, { CANON_URL: URL_, CANON_PROJECT: PROJECT, CANON_KEY: AGENT, CANON_AGENT: a.agent, CANON_WORKDIR: dir }, dir);
for (const a of ATTEMPTS) {
  a.dir = join(work, a.agent);
  mkdirSync(a.dir, { recursive: true });
  const out = cli(a.dir, a, `claim --join ${a.fact} --why ${JSON.stringify(a.why)}${a.after ? ` --after ${a.after}` : ""}`);
  a.claim = out.match(/Claim (c-\w+)/)?.[1];
  a.repo = join(a.dir, readdirSync(a.dir).find((d) => d.startsWith(`${PROJECT}-`)));
  sh(`python3 ${join(ROOT, "scripts/stateless-patches.py")} ${a.repo} ${a.patch}`);
  sh(`git add -A && git -c user.name=${a.agent} -c user.email=${a.agent}@canon.rodeo commit -qm ${JSON.stringify(a.why)}`, {}, a.repo);
}
note(`claimed: ${ATTEMPTS.map((a) => `${a.agent} ${a.claim} ${a.fact}`).join(", ")}`);
const pushedAt = Date.now();
await Promise.all(ATTEMPTS.map((a) => new Promise((ok) => { sh(`git push -q origin main`, {}, a.repo); ok(); })));
note("all five pushed");

// ---- Watch until everything settles: every claim settled or waiting for a person, nothing releasing.
const SETTLED = ["accepted", "superseded", "declined", "contradicts", "unproven", "error"];
const seen = new Map();
let state;
for (let i = 0; i < 360; i++) {
  state = await get("/canon");
  const mine = new Set(ATTEMPTS.map((a) => a.claim));
  const claims = state.claims.filter((c) => mine.has(c.id) || (c.refreshedFrom && [...mine].some((m) => c.refreshedFrom === m)));
  for (const c of state.claims) {
    const key = `${c.id}:${c.status}`;
    if (!seen.has(key) && (mine.has(c.id) || c.refreshedFrom)) { seen.set(key, Date.now()); note(`${c.agent} ${c.id} ${c.factId}: ${c.status}${c.autoWait ? ` (${c.autoWait.slice(0, 90)})` : ""}`); }
  }
  for (const d of state.deploys ?? []) {
    const key = `deploy:${d.seq}:${d.deployed}:${d.health}`;
    if (!seen.has(key)) { seen.set(key, Date.now()); note(`canon #${d.seq} [${d.facts.join(", ")}]: ${d.deployed}${d.health ? ` (${d.health})` : ""}`); }
  }
  for (const t of state.trains ?? []) {
    const key = `train:${t.id}:${t.status}`;
    if (!seen.has(key)) { seen.set(key, Date.now()); note(`train ${t.id}: ${t.status}`); }
  }
  const open = state.claims.filter((c) => !SETTLED.includes(c.status) && !(c.status === "ready" && c.autoWait && !/prerequisite|builds on|waiting for the release|being released|train/.test(c.autoWait)));
  const pending = (state.deploys ?? []).some((d) => d.deployed === "pending");
  const wanted = ["bulk-discount", "quote-has-name", "item-page", "item-link"];
  const doneFacts = wanted.filter((f) => state.facts.find((x) => x.id === f)?.status === "canon");
  if (!open.length && !pending && i > 6) break;
  if (doneFacts.length === wanted.length && !pending && !open.length) break;
  await sleep(10_000);
}
const stats = await get("/stats");
const released = (state.deploys ?? []).filter((d) => d.deployed === "deployed" && d.facts.length);
const records = [];
for (const d of released) records.push({ seq: d.seq, facts: d.facts, record: await get(`/canon/${d.seq}/acceptance`).catch(() => null) });
const deliveredAt = Object.fromEntries(released.flatMap((d) => d.facts.map((f) => [f, seen.get(`deploy:${d.seq}:deployed:${d.health}`) ?? seen.get(`deploy:${d.seq}:deployed:null`) ?? null])));

// ---- The report.
const secs = (x) => (x ? `${Math.round((x - pushedAt) / 1000)} s` : "not delivered");
const lines = [
  "# End to end, on deployed Canon",
  "",
  `Run by \`scripts/e2e.mjs\` on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC against canon.rodeo, judge at revision \`${revision}\`, project [\`${PROJECT}\`](${URL_}/p/${PROJECT}/canon) (left up). **This is deployed execution**, not a simulation: the real judge (a Durable Object), Workflows and Containers for every verification and release, Artifacts forks, Workers Previews, the persistent release candidate, merge trains, the release fence, the rollback rehearsal and the gradual rollout on a live Worker. One run; no person clicked.`,
  "",
  "**Workload.** The stateless Worker from `demo-stateless`, with four backlog facts and policy `" + JSON.stringify(canonFile.policy) + "`. Five attempts pushed within seconds of each other:",
  "",
  ...ATTEMPTS.map((a) => `- ${a.agent} → “${[...canonFile.backlog].find((f) => f.id === a.fact).sentence}” (\`${a.patch}\`${a.after ? `, declared \`--after ${a.after}\`` : ""})`),
  "",
  "agent-2 and agent-3 build the same fact two ways (a duplicate); agent-1's fact needs agent-4's endpoint; the quote changes edit the same line of the handler.",
  "",
  "## Outcome",
  "",
  "| Fact | Delivered to production after the first push |",
  "|---|---|",
  ...["bulk-discount", "quote-has-name", "item-page", "item-link"].map((f) => `| ${canonFile.backlog.find((x) => x.id === f).sentence} | ${secs(deliveredAt[f])} |`),
  "",
  `Releases: ${released.length} (${released.map((d) => `canon #${d.seq}: ${d.facts.join(" + ")}`).join("; ")}). Merge trains landed: ${stats.trainsLanded} (${stats.factsByTrain} facts). Re-applied by the judge: ${stats.reappliedByJudge}. Rejected: ${stats.rejected}. Held back: ${stats.heldBack}. Accepted by a person: ${stats.acceptedByPerson}; by policy: ${stats.acceptedByPolicy}.`,
  "",
  `Verification work: ${stats.pushes} pushes, ${stats.verdicts} verdicts, ${stats.checksRun} checks, ${stats.verifyMinutes} verification minutes; median push to verdict ${stats.medianSecondsToVerdict} s (p90 ${stats.p90SecondsToVerdict} s). Compute the judge times itself: about $${stats.computeUsdEstimate} (${stats.computeBasis}).`,
  "",
  "Acceptance records: " + records.map((r) => `[canon #${r.seq}](${URL_}/p/${PROJECT}/canon/${r.seq}/acceptance)`).join(", ") + ".",
  "",
  ...records.flatMap((r) => r.record ? [`- canon #${r.seq} (${r.facts.join(", ")}): authorized by ${r.record.authorizedBy}; rehearsal ${r.record.recovery?.rehearsal?.state ?? "none"}${r.record.recovery?.rehearsal ? ` (${r.record.recovery.rehearsal.detail.slice(0, 260)})` : ""}; exposure ${(r.record.exposure ?? []).map((e) => `${e.percent}%: ${e.verdict}`).join(", ") || "none recorded"}.`] : []),
  "",
  "## Timeline",
  "",
  "```",
  ...log,
  "```",
  "",
  "What one run shows and doesn't: it is one arrival order on one small app, with the queue that would compete with it not run on deployed infrastructure (the simulated comparison is [docs/benchmark.md](benchmark.md)). Times include Cloudflare's own queueing, container starts and the canary's 30-second holds.",
];
const out = lines.join("\n") + "\n";
if (args.out) writeFileSync(join(ROOT, args.out), out);
console.log(out);
