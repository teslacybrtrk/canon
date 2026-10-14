// The side-by-side, reproducible: one real change (agent-1's bulk discount from the Oct 12 run, fetched read-only from
// canon.rodeo), one base (that run's genesis), one set of inputs, one expected result, two ways of integrating it.
//   CANON  the change is pushed to an isolated project on canon.rodeo (never the public demo's production): the judge
//          runs the protected rule on a live preview and the attempt is not accepted.
//   GIT    the same change merged with plain `git merge` into the same base: no text conflict; then the same rule, with
//          the very inputs the judge drew (same seed), on the merged app running locally: it fails, and nothing stopped it.
// Git plus the same checks would catch this too. What Canon adds is that the rule is protected (agents can't edit it),
// persistent (every later change is judged on it) and part of coordination and release.
//   source scripts/env.sh && node scripts/side-by-side.mjs [--project sbs] [--port 8797]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../referee/src/probe.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const PROJECT = args.project ?? "sbs";
const PORT = Number(args.port ?? 8797);
const URL_ = process.env.CANON_URL;
const sh = (cmd, cwd = ROOT, env = {}) => execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();
const keychain = (name) => sh(`source scripts/env.sh >/dev/null 2>&1; keychain ${name}`).trim();
const OWNER = keychain("canon-owner-key");
const AGENT = keychain("canon-agent-key");
if (!URL_ || !OWNER || !AGENT) throw new Error("source scripts/env.sh first, with both keys in the Keychain");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line = "") => process.stdout.write(`${line}\n`);

// The change: agent-1's first attempt at the bulk discount on Oct 12, as the agent wrote it.
const farm = await (await fetch(`https://canon.rodeo/p/farmstand/canon`)).json();
const claim = farm.claims.filter((c) => c.agent === "agent-1" && !c.refreshedFrom && /10 or more/.test(c.sentence) && c.verdict?.sha).sort((a, b) => a.createdAt - b.createdAt)[0];
if (!claim) throw new Error("agent-1's discount attempt isn't in farmstand's records");
const rule = farm.facts.find((f) => f.id === "price-is-listed");
const work = mkdtempSync(join(tmpdir(), "canon-sbs-"));
const base = join(work, "base");
sh(`git clone -q https://canon.rodeo/a/farmstand-genesis.git ${base}`);
sh(`git fetch -q https://canon.rodeo/a/${claim.attemptId}.git main && git diff --binary HEAD FETCH_HEAD -- . ':(exclude)canon.json' > ${work}/change.patch`, base);
const genesisSha = sh("git rev-parse --short HEAD", base).trim();
const changed = sh(`git apply --numstat ${work}/change.patch`, base).trim().split("\n").map((l) => l.split("\t").slice(0, 3).join(" "));

// CANON: an isolated project with the same genesis; the same change pushed as an attempt; the judge decides.
const app = join(work, "app");
sh(`git clone -q ${base} ${app} && rm -rf ${app}/.git`);
sh(`./scripts/genesis.sh`, ROOT, { CANON_PROJECT: PROJECT, CANON_FILE: join(app, "canon.json"), DEMO_DIR: app, CANON_KEY: OWNER, CANON_PUBLIC: "1" });
const get = async (path) => (await fetch(`${URL_}/p/${PROJECT}${path}`, { headers: { authorization: `Bearer ${OWNER}` } })).json();
for (let i = 0; i < 60 && !(await get("/canon")).canon; i++) await sleep(10_000);
const factFile = join(work, "fact.json");
const fact = farm.facts.find((f) => f.id === claim.factId);
writeFileSync(factFile, JSON.stringify({ id: fact.id, sentence: fact.sentence, check: fact.check }));
const env = { PATH: `${ROOT}cli:${process.env.PATH}`, CANON_PROJECT: PROJECT, CANON_KEY: AGENT, CANON_AGENT: "agent-1", CANON_WORKDIR: join(work, "attempts") };
const out = sh(`canon claim --fact ${factFile} --why ${JSON.stringify(`${claim.why} (the Oct 12 change, replayed)`)}`, work, env);
const attemptDir = out.match(/cloned to (\S+)/)[1];
sh(`git apply ${work}/change.patch && git add -A && git -c user.name=agent-1 -c user.email=agent-1@canon.local commit -qm "bulk discount (agent-1's Oct 12 change, replayed)" && git push -q origin main`, attemptDir);
let v;
for (let i = 0; i < 60; i++) {
  v = await get(`/attempts/${attemptDir.split("/").pop()}/verdict`);
  if (v?.outcome && v.outcome !== "pending") break;
  await sleep(10_000);
}
const lost = v.lost.find((l) => l.factId === rule.id);

// GIT: the same change merged into the same base, then the same rule with the judge's own inputs (same seed).
const merged = join(work, "git");
sh(`git clone -q ${base} ${merged} && git -C ${merged} checkout -q -b discount && git -C ${merged} apply ${work}/change.patch && git -C ${merged} add -A && git -C ${merged} -c user.name=agent-1 -c user.email=agent-1@canon.local commit -qm "bulk discount" && git -C ${merged} checkout -q main`);
const mergeOut = sh(`git -c user.name=maintainer -c user.email=m@local merge --no-ff -m "Merge bulk discount" discount 2>&1`, merged).trim();
sh("npm ci --no-audit --no-fund --ignore-scripts", merged);
const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], { cwd: merged, stdio: "ignore", detached: true });
const local = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) { try { if ((await fetch(local)).status) break; } catch {} await sleep(500); }
const gitRun = await runCheck(rule.check, local, `${v.sha}:${v.seed}:${rule.id}`);
try { process.kill(-dev.pid); } catch {}

const W = 58;
const col = (l, r) => say(`${String(l).padEnd(W).slice(0, W)} │ ${r}`);
say(`The same change, base and inputs, two ways of integrating it (${new Date().toISOString().slice(0, 16)}Z)`);
say(`Change: agent-1's bulk discount from the Oct 12 run (attempt ${claim.attemptId}), ${changed.join(", ")}`);
say(`Base: farmstand genesis ${genesisSha}. Rule: “${rule.sentence}”. Inputs: the judge's seed ${v.seed} for commit ${v.sha.slice(0, 7)}.`);
say("");
col("PLAIN GIT", "CANON");
col("─".repeat(W), "─".repeat(W));
col(`$ git merge --no-ff discount`, `$ git push origin main   (attempt ${v.attemptId})`);
col(mergeOut.split("\n")[0], `verdict: ${v.outcome.toUpperCase()}`);
col("text merge: no conflict", `the protected rule, on a live preview of ${v.sha.slice(0, 7)}:`);
col(`the rule, on the merged app (same inputs):`, lost ? `  FAILS: ${lost.detail}` : "  holds");
col(gitRun.held ? "  holds" : `  FAILS: ${gitRun.detail}`, `not accepted: canon and production stay as they were`);
col("nothing stopped it: main now charges the wrong price", `record: ${URL_}/p/${PROJECT}/attempts/${v.attemptId}/verdict`);
say("");
say("Git plus the same checks could catch this too. Canon makes approved requirements persistent, protected (agents can't");
say("edit them), and part of coordination and release.");
rmSync(work, { recursive: true, force: true });
