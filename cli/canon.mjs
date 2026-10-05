#!/usr/bin/env node
// canon: the four moves from a shell, for any coding agent that can run commands.
//
//   canon read [--for <path>]                   1. read canon, the backlog and claims in flight (--for: facts governing a file)
//   canon claim --fact <file.json> --why "..."  2. declare a new fact (or a revision: "replaces" a canon fact)
//   canon claim --join <fact-id>   --why "..."     ...or race for a fact someone already proposed
//   git push                                    3. push the world (plain Git, from inside the world)
//   canon verdict [--wait]                      4. which facts held, which broke, accepted or not
//   canon refresh                               a BEHIND world: new world from current canon + your changes
//   canon why <fact-id>                         the fact chain: who made it true, which worlds failed it
//   canon init                                  a starter canon.json for the app in this folder
//
// Env: CANON_URL (referee origin), CANON_PROJECT (e.g. farmstand), CANON_AGENT (e.g. agent-3),
//      CANON_KEY (the key that lets you claim; agents get the referee's CANON_AGENT_KEY),
//      CANON_WORKDIR (where worlds are cloned; default ./worlds)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const URL_BASE = process.env.CANON_URL?.replace(/\/$/, "");
const PROJECT = process.env.CANON_PROJECT ?? "farmstand";
const AGENT = process.env.CANON_AGENT ?? process.env.USER ?? "agent";
const KEY = process.env.CANON_KEY;
// Coding agents background shell commands that run past about 2 minutes, then lose the result.
// One wait stays under that; if no verdict yet, the command says to run it again.
const WAIT_MS = 100_000;

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (!["read", "claim", "verdict", "refresh", "why", "init"].includes(cmd)) usage();
  if (cmd === "init") init();
  else if (!URL_BASE) fail("set CANON_URL to the referee origin");
  else if (cmd === "read") await read();
  else if (cmd === "claim") await claim();
  else if (cmd === "verdict") await verdict();
  else if (cmd === "refresh") await refresh();
  else if (cmd === "why") await why(args._[0]);
  else usage();
} catch (err) {
  fail(err.message);
}

async function read() {
  const s = await api("GET", "/canon");
  if (!s.canon) return console.log("No canon yet (genesis has not passed its seed facts).");
  // --for <path>: only the facts that govern that file (scoped facts that match, plus unscoped ones).
  const forPath = typeof args.for === "string" ? args.for.replace(/^\.\//, "") : null;
  const applies = (f) => !forPath || !f.scope || f.scope.some((g) => globToRegExp(g).test(forPath));
  const facts = s.facts.filter(applies);
  const label = (f) => `${f.id.padEnd(28)} ${f.sentence}${f.scope ? `  [${f.scope.join(", ")}]` : ""}${f.check.kind === "command" ? `  (runs: ${f.check.run})` : ""}`;
  console.log(`CANON  world ${s.canon.worldId} @ ${s.canon.sha.slice(0, 8)}  (seq ${s.canon.seq})${s.policy?.autoAccept === "backlog" ? "  · autopilot: backlog facts land on their own" : ""}`);
  if (forPath) console.log(`(facts that govern ${forPath})`);
  for (const f of facts.filter((f) => f.status === "canon")) console.log(`  ✓ ${label(f)}`);
  const claimsFor = (id) => s.claims.filter((c) => c.factId === id && !["superseded"].includes(c.status));
  const proposed = facts.filter((f) => f.status === "proposed");
  const backlog = proposed.filter((f) => f.origin === "backlog");
  const byAgents = proposed.filter((f) => f.origin !== "backlog");
  if (backlog.length) console.log(`\nBACKLOG (written by people; claim one with: canon claim --join <id>)`);
  for (const f of backlog) console.log(`  ? ${label(f)}  · ${claimsFor(f.id).length} claim(s)`);
  if (byAgents.length) console.log(`\nPROPOSED BY AGENTS`);
  for (const f of byAgents) console.log(`  ? ${label(f)}${f.replaces ? `  (revises ${f.replaces})` : ""}`);
  const retired = facts.filter((f) => f.status === "retired");
  if (retired.length) console.log(`\nRETIRED`);
  for (const f of retired) console.log(`  ✗ ${f.id.padEnd(28)} ${f.sentence}`);
  const live = s.claims.filter((c) => !["accepted", "superseded"].includes(c.status));
  if (live.length) console.log(`\nCLAIMS IN FLIGHT`);
  for (const c of live) console.log(`  ${c.agent} is trying to make "${c.sentence}" true  [${c.status}]`);
}

async function claim() {
  if (!args.why) fail('--why "<reason>" is required: it becomes part of the fact chain');
  const body = { agent: AGENT, why: args.why };
  if (args.join && args.fact) fail("use either --fact <file.json> (a new fact or a revision) or --join <fact-id>, not both");
  if (args.join) body.join = args.join;
  else if (args.fact) body.fact = JSON.parse(readFileSync(factFile(args.fact), "utf8"));
  else fail("pass --fact <file.json> (id, sentence, check) or --join <fact-id>");

  const { claim, world } = await api("POST", "/claims", body);
  const dir = resolve(process.env.CANON_WORKDIR ?? "worlds", world.id);
  await setupWorld(dir, claim, world, body.fact ?? (await api("GET", "/canon")).facts.find((f) => f.id === claim.factId));

  console.log(`Claim ${claim.id}: ${AGENT} is trying to make "${claim.factId}" true.`);
  console.log(`World ${world.id} cloned to ${dir} (your fact is already in its canon.json; do not edit that file).`);
  console.log(`Work there, commit, then: git push origin main && canon verdict --wait`);
}

// Clone a new world, mark it as Canon's, and commit the claimed fact into its canon.json.
// The fact travels with the code; the referee rejects a world whose canon.json changes anything else.
async function setupWorld(dir, claim, world, fact) {
  const remote = new URL(world.remote);
  remote.username = "x";
  remote.password = world.token;
  git(["clone", "--quiet", remote.toString(), dir]);
  git(["-C", dir, "config", "user.name", AGENT]);
  git(["-C", dir, "config", "user.email", `${AGENT}@canon.local`]);
  writeFileSync(join(dir, ".git", "canon.json"), JSON.stringify({ project: PROJECT, claimId: claim.id, worldId: world.id, factId: claim.factId, agent: AGENT }, null, 2));
  installTrailerHook(dir, claim);
  const ledgerPath = join(dir, "canon.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const def = { id: fact.id, sentence: fact.sentence, check: fact.check };
  if (fact.scope?.length) def.scope = fact.scope;
  if (fact.replaces) def.replaces = fact.replaces;
  // A revision drops the fact it replaces; a backlog fact moves from the backlog into the facts.
  if (fact.replaces) ledger.facts = ledger.facts.filter((f) => f.id !== fact.replaces);
  if (Array.isArray(ledger.backlog)) ledger.backlog = ledger.backlog.filter((f) => f.id !== fact.id);
  if (ledger.backlog?.length === 0) delete ledger.backlog;
  if (!ledger.facts.some((f) => f.id === fact.id)) ledger.facts.push(def);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  git(["-C", dir, "commit", "--quiet", "-am", `canon: claim "${fact.sentence}"`]);
}

// A world that is BEHIND was built on an older canon. Make a fresh world from the current
// canon for the same fact, and re-apply this world's own changes on top of it. The agent
// (not the referee) resolves any conflict; nothing is merged on the server.
async function refresh() {
  const old = worldContext();
  // Only a world that is behind needs a fresh copy of canon; refreshing anything else just makes noise.
  const last = await api("GET", `/worlds/${old.worldId}/verdict`, undefined, true);
  const mine = (await api("GET", "/canon")).claims.find((c) => c.id === old.claimId);
  if (mine?.status === "superseded") fail(`this world was already refreshed or replaced; work in your newest world (canon verdict shows it)`);
  if (last.outcome !== "behind") fail(`refresh is only for worlds that are BEHIND canon; this one is ${String(last.outcome).toUpperCase()}. Read its verdict instead.`);
  const head = git(["-C", old.root, "rev-parse", "HEAD"]).trim();
  const claimCommit = git(["-C", old.root, "log", "--format=%H", "--grep=^canon: claim", "-n", "1"]).trim();
  if (!claimCommit) fail("cannot find this world's claim commit");
  const patch = git(["-C", old.root, "diff", "--binary", `${claimCommit}..${head}`, "--", ".", ":(exclude)canon.json"]);

  // The agent's original reason carries over: the why belongs to the change, not to the refresh.
  const state = await api("GET", "/canon");
  const original = state.claims.find((c) => c.id === old.claimId)?.why ?? "";
  const { claim, world } = await api("POST", "/claims", {
    agent: AGENT,
    why: `${original} (refreshed onto canon ${state.canon.seq})`.trim(),
    join: old.factId,
    replaces: old.claimId,
  });
  const dir = resolve(dirname(old.root), world.id);
  await setupWorld(dir, claim, world, state.facts.find((f) => f.id === claim.factId));

  if (patch.trim()) {
    const patchFile = join(dir, ".git", "canon-refresh.patch");
    writeFileSync(patchFile, patch);
    try {
      execFileSync("git", ["-C", dir, "apply", "--3way", patchFile], { stdio: ["ignore", "pipe", "pipe"] });
      git(["-C", dir, "commit", "--quiet", "-am", `Re-apply ${old.worldId} on the current canon`]);
      console.log(`Re-applied your changes from ${old.worldId}.`);
    } catch {
      console.log(`Your changes from ${old.worldId} conflict with the current canon. Resolve the conflict markers in ${dir}, then commit.`);
    }
  }
  console.log(`New world ${world.id} at ${dir}. cd there, then: git push origin main && canon verdict --wait`);
}

async function verdict() {
  const ctx = worldContext();
  const head = git(["-C", ctx.root, "rev-parse", "HEAD"]).trim();
  const deadline = Date.now() + (args.wait ? WAIT_MS : 0);
  let v;
  for (;;) {
    v = await api("GET", `/worlds/${ctx.worldId}/verdict`, undefined, true);
    const current = v.sha === head && v.outcome !== "pending";
    if (current || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (v.sha !== head) {
    const pushed = git(["-C", ctx.root, "ls-remote", "origin", "refs/heads/main"]).startsWith(head);
    console.log(pushed
      ? `Still judging ${head.slice(0, 8)} (the preview is building). Run \`canon verdict --wait\` again.`
      : `No verdict for ${head.slice(0, 8)}: it is not pushed. Run \`git push origin main\` first.`);
    process.exit(3);
  }
  console.log(`VERDICT ${v.outcome.toUpperCase()}  world ${v.worldId} @ ${v.sha.slice(0, 8)}`);
  if (v.outcome === "error") {
    console.log(`\n${v.claimed.detail}\nThis is not about your code. Push again (an empty commit is fine: git commit --allow-empty -m retry && git push origin main), then canon verdict --wait.`);
    process.exit(2);
  }
  if (v.previewUrl) console.log(`preview  ${v.previewUrl}`);
  for (const id of v.kept) console.log(`  kept     ${id}`);
  for (const l of v.lost) console.log(`  LOST     ${l.factId}: ${l.detail}`);
  for (const l of v.stale ?? []) console.log(`  NEWER    ${l.factId} became canon after you forked: ${l.detail}`);
  for (const id of v.retires ?? []) console.log(`  RETIRES  ${id} (your claim revises this rule on purpose; a person decides)`);
  if (v.skipped?.length) console.log(`  skipped  ${v.skipped.join(", ")} (out of scope: you changed none of their files)`);
  console.log(`  claimed  ${v.claimed.factId}: ${v.claimed.held ? "holds" : v.claimed.detail}`);
  for (const id of v.offers) console.log(`  offers   ${id}`);
  if (v.outcome === "ready") console.log(`\nReady. A human decides whether "${v.claimed.factId}" becomes canon.`);
  if (v.outcome === "contradicts") {
    const lostIds = v.lost.map((l) => l.factId).filter((id) => id !== "canon.json");
    console.log(`\nThis world contradicts canon. Make the lost facts hold again and push.`);
    if (lostIds.length) console.log(`If your goal is to change ${lostIds.join(", ")} on purpose, this world cannot land. Propose a revision instead:\n  canon claim --fact <revision.json> --why "<why the rule changes>"\n(a fact file with "replaces": "${lostIds[0]}"). That gives you a new world; implement the change there.`);
  }
  if (v.outcome === "unproven") console.log(`\nCanon held, but your fact does not hold yet. Fix and push again.`);
  if (v.outcome === "behind") console.log(`\nCanon moved after this world forked. Run: canon refresh`);
  process.exit(v.outcome === "ready" ? 0 : 2);
}

async function why(factId) {
  if (!factId) fail("usage: canon why <fact-id>");
  const w = await api("GET", `/facts/${factId}/why`);
  console.log(`${w.fact.id} [${w.fact.status}]  ${w.fact.sentence}`);
  if (w.madeTrueBy) console.log(`  made true by ${w.madeTrueBy.world.id} (${w.madeTrueBy.claim?.agent}: ${w.madeTrueBy.claim?.why})  ${w.madeTrueBy.world.previewUrl ?? ""}`);
  if (w.replaces) console.log(`  revises     ${w.replaces.id}: ${w.replaces.sentence}`);
  if (w.retiredBy) console.log(`  retired by  ${w.retiredBy.world?.id} (${w.retiredBy.claim?.agent}: ${w.retiredBy.claim?.why}), replaced by ${w.retiredBy.replacement?.id ?? "?"}`);
  for (const r of w.rejected) console.log(`  failed on  ${r.world_id} @ ${String(r.sha).slice(0, 8)} (${r.agent ?? "genesis"}): ${r.detail}  ${r.preview_url ?? ""}`);
}

// ---- helpers --------------------------------------------------------------------

// A fact file path works from anywhere: relative to here, or a file in the agent's claims folder (CANON_CLAIMS).
function factFile(path) {
  if (existsSync(path)) return path;
  const claimed = process.env.CANON_CLAIMS ? join(process.env.CANON_CLAIMS, path.split("/").pop()) : "";
  if (claimed && existsSync(claimed)) return claimed;
  fail(`no fact file ${path}${process.env.CANON_CLAIMS ? ` (also looked in ${process.env.CANON_CLAIMS})` : ""}`);
}

async function api(method, path, body, allowPending = false) {
  const res = await fetch(`${URL_BASE}/p/${PROJECT}${path}`, {
    method,
    // Reads are public; only writes carry the key.
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(KEY && method !== "GET" ? { authorization: `Bearer ${KEY}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 202 && allowPending) return data;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error ?? JSON.stringify(data)}`);
  return data;
}

function worldContext() {
  let dir = process.cwd();
  while (!existsSync(join(dir, ".git", "canon.json"))) {
    const up = dirname(dir);
    if (up === dir) {
      // Not inside a world: use this agent's most recently claimed world under CANON_WORKDIR (default ./worlds).
      const root = resolve(process.env.CANON_WORKDIR ?? "worlds");
      const worlds = existsSync(root)
        ? readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, ".git", "canon.json")))
        : [];
      if (!worlds.length) fail("not inside a Canon world (run `canon claim` first, then cd into the world)");
      dir = worlds.sort((a, b) => statSync(join(b, ".git", "canon.json")).mtimeMs - statSync(join(a, ".git", "canon.json")).mtimeMs)[0];
      console.error(`(using your latest world: ${dir})`);
      break;
    }
    dir = up;
  }
  return { root: dir, ...JSON.parse(readFileSync(join(dir, ".git", "canon.json"), "utf8")) };
}

// Every commit in a world carries the claim it serves: the "why" travels with the code.
function installTrailerHook(dir, claim) {
  const hook = join(dir, ".git", "hooks", "commit-msg");
  writeFileSync(
    hook,
    `#!/bin/sh
git interpret-trailers --in-place --if-exists doNothing \\
  --trailer "Canon-Fact: ${claim.factId}" \\
  --trailer "Canon-Claim: ${claim.id}" \\
  --trailer "Canon-Agent: ${AGENT}" "$1"
`,
  );
  chmodSync(hook, 0o755);
}

// Same glob rules as the referee: ** spans directories, * stays within one.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

// A starter canon.json for the app in this folder, from what it finds: the home page answers, the code
// type-checks (with tsconfig.json), and the toolchain and deploy config only change by revision. Never overwrites.
function init() {
  if (existsSync("canon.json")) fail("canon.json already exists here");
  const facts = [
    { id: "home-page-answers", sentence: "The home page answers", check: { kind: "probe", isolate: false, steps: [{ path: "/", expect: { status: 200 } }] } },
  ];
  if (existsSync("tsconfig.json")) {
    facts.push({ id: "code-typechecks", sentence: "The code type-checks, with no errors silenced",
      check: { kind: "command", run: "npx tsc --noEmit -p tsconfig.json && ! grep -rnE '@ts-(ignore|nocheck|expect-error)' src" } });
  }
  const pinned = ["package.json", "package-lock.json", "wrangler.jsonc", "wrangler.json", "wrangler.toml", "tsconfig.json", "biome.json"].filter((f) => existsSync(f));
  if (pinned.length) {
    const sums = pinned.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")} ${f}`).join(" ");
    facts.push({ id: "tooling-locked", sentence: "The toolchain and deploy config only change by revision",
      check: { kind: "command", run: `printf '%s  %s\\n' ${sums} | sha256sum -c --quiet -` }, scope: pinned });
  }
  writeFileSync("canon.json", JSON.stringify({ version: 1, facts }, null, 2) + "\n");
  console.log(`Wrote canon.json with ${facts.length} starter facts: ${facts.map((f) => f.id).join(", ")}.`);
  console.log("Next: add the few behaviours that must never break silently (money, permissions, data), check them against");
  console.log("your app running locally, commit, and import the repo. The guide: docs/USING.md");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      out[key] = next === undefined || next.startsWith("--") ? true : (i++, next);
    } else out._.push(argv[i]);
  }
  return out;
}

function usage() {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}

function fail(msg) {
  console.error(`canon: ${msg}`);
  process.exit(1);
}
