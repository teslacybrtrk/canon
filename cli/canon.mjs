#!/usr/bin/env node
// canon: the four moves from a shell, for any coding agent that can run commands.
//
//   canon read                                  1. read canon and claims in flight
//   canon claim --fact <file.json> --why "..."  2. declare a new fact, get a world (fork) to work in
//   canon claim --join <fact-id>   --why "..."     ...or race for a fact someone already proposed
//   git push                                    3. push the world (plain Git, from inside the world)
//   canon verdict [--wait]                      4. which facts held, which broke, accepted or not
//   canon why <fact-id>                         the fact chain: who made it true, which worlds failed it
//
// Env: CANON_URL (referee origin), CANON_PROJECT (e.g. farmstand), CANON_AGENT (e.g. agent-3),
//      CANON_WORKDIR (where worlds are cloned; default ./worlds)

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const URL_BASE = process.env.CANON_URL?.replace(/\/$/, "");
const PROJECT = process.env.CANON_PROJECT ?? "farmstand";
const AGENT = process.env.CANON_AGENT ?? process.env.USER ?? "agent";
const WAIT_MS = 15 * 60_000;

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (!["read", "claim", "verdict", "why"].includes(cmd)) usage();
  if (!URL_BASE) fail("set CANON_URL to the referee origin");
  if (cmd === "read") await read();
  else if (cmd === "claim") await claim();
  else if (cmd === "verdict") await verdict();
  else if (cmd === "why") await why(args._[0]);
  else usage();
} catch (err) {
  fail(err.message);
}

async function read() {
  const s = await api("GET", "/canon");
  if (!s.canon) return console.log("No canon yet (genesis has not passed its seed facts).");
  console.log(`CANON  world ${s.canon.worldId} @ ${s.canon.sha.slice(0, 8)}  (seq ${s.canon.seq})`);
  for (const f of s.facts.filter((f) => f.status === "canon")) console.log(`  ✓ ${f.id.padEnd(26)} ${f.sentence}`);
  const proposed = s.facts.filter((f) => f.status === "proposed");
  if (proposed.length) console.log(`\nPROPOSED`);
  for (const f of proposed) console.log(`  ? ${f.id.padEnd(26)} ${f.sentence}`);
  const live = s.claims.filter((c) => !["accepted", "superseded"].includes(c.status));
  if (live.length) console.log(`\nCLAIMS IN FLIGHT`);
  for (const c of live) console.log(`  ${c.agent} is trying to make "${c.sentence}" true  [${c.status}]`);
}

async function claim() {
  if (!args.why) fail('--why "<reason>" is required: it becomes part of the fact chain');
  const body = { agent: AGENT, why: args.why };
  if (args.join) body.join = args.join;
  else if (args.fact) body.fact = JSON.parse(readFileSync(args.fact, "utf8"));
  else fail("pass --fact <file.json> (id, sentence, check) or --join <fact-id>");

  const { claim, world } = await api("POST", "/claims", body);
  const dir = resolve(process.env.CANON_WORKDIR ?? "worlds", world.id);
  const remote = new URL(world.remote);
  remote.username = "x";
  remote.password = world.token;
  git(["clone", "--quiet", remote.toString(), dir]);
  git(["-C", dir, "config", "user.name", AGENT]);
  git(["-C", dir, "config", "user.email", `${AGENT}@canon.local`]);
  writeFileSync(join(dir, ".git", "canon.json"), JSON.stringify({ project: PROJECT, claimId: claim.id, worldId: world.id, factId: claim.factId, agent: AGENT }, null, 2));
  installTrailerHook(dir, claim);

  // The claimed fact travels with the code: add it to the world's canon.json and commit.
  // The referee rejects a world whose canon.json changes anything else.
  const fact = body.fact ?? (await api("GET", "/canon")).facts.find((f) => f.id === claim.factId);
  const ledgerPath = join(dir, "canon.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (!ledger.facts.some((f) => f.id === fact.id)) ledger.facts.push({ id: fact.id, sentence: fact.sentence, check: fact.check });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  git(["-C", dir, "commit", "--quiet", "-am", `canon: claim "${fact.sentence}"`]);

  console.log(`Claim ${claim.id}: ${AGENT} is trying to make "${claim.factId}" true.`);
  console.log(`World ${world.id} cloned to ${dir} (your fact is already in its canon.json; do not edit that file).`);
  console.log(`Work there, commit, then: git push origin main && canon verdict --wait`);
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
    console.log(`No verdict for ${head.slice(0, 8)} yet${v.sha ? ` (last verdict was for ${v.sha.slice(0, 8)})` : ""}. Did you push?`);
    process.exit(3);
  }
  console.log(`VERDICT ${v.outcome.toUpperCase()}  world ${v.worldId} @ ${v.sha.slice(0, 8)}`);
  if (v.previewUrl) console.log(`preview  ${v.previewUrl}`);
  for (const id of v.kept) console.log(`  kept     ${id}`);
  for (const l of v.lost) console.log(`  LOST     ${l.factId}: ${l.detail}`);
  console.log(`  claimed  ${v.claimed.factId}: ${v.claimed.held ? "holds" : v.claimed.detail}`);
  for (const id of v.offers) console.log(`  offers   ${id}`);
  if (v.outcome === "ready") console.log(`\nReady. A human decides whether "${v.claimed.factId}" becomes canon.`);
  if (v.outcome === "contradicts") console.log(`\nThis world contradicts canon. Make the lost facts hold again (or drop the change), then push.`);
  if (v.outcome === "unproven") console.log(`\nCanon held, but your fact does not hold yet. Fix and push again.`);
  if (v.outcome === "behind") console.log(`\n${v.ledger.detail}.`);
  process.exit(v.outcome === "ready" ? 0 : 2);
}

async function why(factId) {
  if (!factId) fail("usage: canon why <fact-id>");
  const w = await api("GET", `/facts/${factId}/why`);
  console.log(`${w.fact.id} [${w.fact.status}]  ${w.fact.sentence}`);
  if (w.madeTrueBy) console.log(`  made true by ${w.madeTrueBy.world.id} (${w.madeTrueBy.claim?.agent}: ${w.madeTrueBy.claim?.why})  ${w.madeTrueBy.world.previewUrl ?? ""}`);
  for (const r of w.rejected) console.log(`  failed on  ${r.world_id} @ ${String(r.sha).slice(0, 8)} (${r.agent ?? "genesis"}): ${r.detail}  ${r.preview_url ?? ""}`);
}

// ---- helpers --------------------------------------------------------------------

async function api(method, path, body, allowPending = false) {
  const res = await fetch(`${URL_BASE}/p/${PROJECT}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
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
    if (up === dir) fail("not inside a Canon world (run `canon claim` first, then cd into the world)");
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

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
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
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(1);
}

function fail(msg) {
  console.error(`canon: ${msg}`);
  process.exit(1);
}
