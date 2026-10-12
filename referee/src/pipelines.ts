import { CIWorkflow, isCiRunnerFailure, type CiContext, type CiParams, type CiRunnerResult, type CloudflareArtifacts } from "@cloudflare/ci";
import { commandFailure, commandScript, exitedNonZero, heldOnBase, parseCommandResults, PLATFORM_RETRIES, type Novelty } from "./commands";
import type { CheckResult } from "./protocol";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { refereeForRepo } from "./stub";

// Started by the cf.artifacts.repo.pushed trigger for every repo in the namespace.
// Builds the pushed attempt as a Workers Preview, then hands it to the referee to judge.
export class VerifyAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo, sha, branch } = event.payload;
    if (branch !== "main") return;
    const referee = refereeForRepo(this.env, repo);
    const attemptId = await step.do("register push", () => referee.pushed(repo, sha));
    if (!attemptId) return;

    // One Preview per pushed commit. Within a single Preview, Durable Objects always run the
    // latest push, so only a Preview of its own keeps a judged attempt exactly as it was.
    const previewName = `${repo}-${sha.slice(0, 7)}`;

    // A command that exits non-zero is a verdict about the code. Anything else (container capacity,
    // RPC or Workflows trouble) is the platform: retry with growing waits, and never blame the code.
    const withRetries = async <T>(label: string, run: (retry: number) => Promise<T>): Promise<T> => {
      for (let retry = 0; ; retry++) {
        try {
          return await run(retry);
        } catch (err) {
          if (exitedNonZero(err) || retry >= PLATFORM_RETRIES) throw err;
          await step.sleep(`${label}: platform retry ${retry + 1}`, `${15 * 2 ** retry} seconds`);
        }
      }
    };
    const once = { retries: { limit: 0, delay: 1_000 }, timeout: 10 * 60_000 } as const;
    const named = (name: string, retry: number) => (retry ? `${name} (retry ${retry})` : name);

    let previewUrl: string;
    let deps: CiRunnerResult;
    try {
      // Pushed code is untrusted, so its dependencies never get to run install scripts.
      deps = await withRetries("install", (a) =>
        ci.runner({ name: named("install", a), command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] }, config: once }),
      );
      const preview = await withRetries("preview", (a) =>
        deps.runner({
          name: named("preview", a),
          command: `npx wrangler preview --name ${previewName} --json`,
          cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
          config: once,
        }),
      );
      previewUrl = previewUrlFrom(preview.logs, previewName) ?? this.env.PREVIEW_URL_TEMPLATE.replace("{name}", previewName);
    } catch (err) {
      const detail = isCiRunnerFailure(err) ? err.message : String(err);
      if (exitedNonZero(err)) await step.do("build failed", () => referee.buildFailed(repo, sha, detail));
      else await step.do("could not judge", () => referee.couldNotJudge(repo, sha, detail));
      return;
    }

    // Command facts (lint, types, tests, budgets) run on this commit's checkout in ONE container,
    // from the installed snapshot. The commands come from canon, never from the attempt.
    const commands = await step.do("command facts", () => referee.commandsFor(repo, sha));
    // A claimed command fact also runs on the commit the attempt forked from: if it passes there, it isn't new.
    const base: Novelty | null = await step.do("forked-from commit", async () => {
      const n = await referee.noveltyFor(repo, sha);
      return n ? { factId: n.factId, run: n.run, files: n.files.map((f) => ({ path: f.path, b64: f.b64 })) } : null;
    });
    let results: Record<string, CheckResult> = {};
    let notNew: string | undefined;
    if (commands.length) {
      try {
        const ran = await withRetries("facts", (a) =>
          deps.runner({ name: named("command facts", a), command: commandScript(commands, base), config: once }),
        );
        const stdout = typeof ran.logs.stdout === "string" ? ran.logs.stdout : "";
        results = parseCommandResults(commands, stdout);
        if (base && heldOnBase(base, stdout)) notNew = base.factId;
      } catch (err) {
        await step.do("could not judge", () => referee.couldNotJudge(repo, sha, isCiRunnerFailure(err) ? err.message : String(err)));
        return;
      }
    }

    try {
      await step.do("judge", { retries: { limit: 4, delay: 10_000, backoff: "linear" }, timeout: 5 * 60_000 }, async () => {
        await referee.judge(repo, sha, previewUrl, results, notNew);
      });
    } catch (err) {
      // Out of retries (the Preview never served, or Artifacts kept failing): say so, rather than leave it judging.
      await step.do("could not judge", () => referee.couldNotJudge(repo, sha, String(err)));
    }
  }
}

// Started by the referee when a human accepts a fact. Deploys the accepted attempt to production.
export class PromoteAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const seq = Number(event.instanceId.match(/^promote-(\d+)-/)?.[1] ?? 0);
    const referee = refereeForRepo(this.env, repo);
    // A later accept already moved canon on: its own deploy wins, and this older one must not land after it.
    if ((await step.do("still the latest canon", () => referee.canonSeq())) > seq) return;
    let ok = true;
    let versionId: string | null = null;
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] } });
      // Each project deploys under its own Worker name, so projects never share a production app.
      const project = repo.slice(0, repo.lastIndexOf("-"));
      const creds = { accountId: this.env.CLOUDFLARE_ACCOUNT_ID };
      // Step one, the release candidate: the whole commit on its own Worker with production's config, so every fact
      // runs on all of its code (Durable Objects included) before production is touched.
      await deps.runner({ name: "deploy release candidate", command: `npx wrangler deploy --name ${project}-candidate`, cloudflareCredentials: creds });
      const candidateOk = await step.do("check release candidate", { timeout: "10 minutes" }, async () => await referee.candidateCheck(seq));
      if (!candidateOk) throw new Error("held back: the release candidate broke a fact");
      // Step two: upload the exact commit as a new Worker version that serves nobody yet; the judge's gate stages it at
      // 0%, smoke-tests every fact on the production URL against it, and only then releases it.
      let atomic = false;
      const run = await deps.runner({ name: "upload version", command: `npx wrangler versions upload --name ${project}`, cloudflareCredentials: creds }).catch((err) => {
        // Only a Durable Object class change may skip the gate: Cloudflare can't upload it as a version (it's atomic).
        // Any other upload failure stops the release.
        const why = isCiRunnerFailure(err) ? err.message : String(err);
        if (!/migration|lifecycle|durable object class/i.test(why)) throw err;
        atomic = true;
        return null;
      });
      if (atomic || !run) {
        // The release candidate already ran this code in full; deploy it, and the check right after the release (and
        // its rollback) is the net.
        const deployed = await deps.runner({ name: "deploy", command: `npx wrangler deploy --name ${project}`, cloudflareCredentials: creds });
        const out = typeof deployed.logs.stdout === "string" ? deployed.logs.stdout : "";
        versionId = out.match(/Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
      } else {
        const out = typeof run.logs.stdout === "string" ? run.logs.stdout : "";
        versionId = out.match(/Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
        if (!versionId) throw new Error("no version id in the upload output");
        const id = versionId;
        const released = await step.do("release gate", { timeout: "10 minutes" }, async () => (await referee.gate(seq, id)).released);
        ok = released;
      }
    } catch {
      ok = false;
    }
    await step.do("record promotion", () => referee.promoted(seq, ok, versionId));
    // The fact chain goes into Git as notes on the canon commits. Best effort: the deploy above is what counts.
    try {
      const env = await step.do("notes job", async () => {
        const job = await referee.noteJob(seq);
        return job ? (Object.fromEntries(Object.entries(job)) as Record<string, string>) : null;
      });
      if (env) await ci.runner({ name: "write notes", command: NOTES_SCRIPT, env, config: { retries: { limit: 1, delay: 10_000 }, timeout: 3 * 60_000 } });
    } catch {
      // The notes are rewritten in full on the next promotion.
    }
  }
}

// Runs in the CI container: writes refs/notes/canon (one note per canon commit) and pushes it to the canon attempt.
// The previous canon's notes are fetched first, so a note the judge could not regenerate is still carried forward.
const NOTES_SCRIPT = [
  `set -e`,
  `rm -rf /tmp/canon-notes && git init -q /tmp/canon-notes && cd /tmp/canon-notes`,
  `git config user.name "Canon judge" && git config user.email "judge@canon.rodeo"`,
  `git fetch -q "$CANON_URL" main`,
  `git fetch -q "$CANON_URL" refs/notes/canon:refs/notes/canon 2>/dev/null || { [ -n "$PREV_URL" ] && git fetch -q "$PREV_URL" refs/notes/canon:refs/notes/canon 2>/dev/null; } || true`,
  `printf %s "$NOTES" | base64 -d > /tmp/canon-notes.json`,
  `node -e 'const n=require("/tmp/canon-notes.json");n.forEach((x,i)=>require("fs").writeFileSync("/tmp/canon-note-"+i,x.sha+"\\n"+x.text))'`,
  `for f in /tmp/canon-note-*; do sha=$(head -n 1 "$f"); tail -n +2 "$f" > /tmp/canon-note-body; git notes --ref=canon add -f -F /tmp/canon-note-body "$sha" 2>/dev/null || echo "skipped $sha"; done`,
  `git push -q -f "$CANON_URL" refs/notes/canon:refs/notes/canon`,
  `echo CANON_NOTES_PUSHED`,
].join("\n");

// Started by the judge when canon moved under an attempt. The judge already declared a new attempt from the current
// canon for the same agent and fact; this re-applies the old attempt's change there and pushes it (what `canon refresh`
// does on an agent's machine). The push event then judges it like any other. A text conflict goes back to the agent.
export class RefreshAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const referee = refereeForRepo(this.env, repo);
    let env: Record<string, string> | null;
    try {
      env = await step.do("refresh job", async () => {
        const job = await referee.refreshJob(repo);
        return job ? (Object.fromEntries(Object.entries(job)) as Record<string, string>) : null;
      });
    } catch (err) {
      await step.do("record refresh", () => referee.refreshed(repo, "failed", String(err)));
      return;
    }
    if (!env) return;
    let outcome: "pushed" | "conflict" | "failed" = "failed";
    let detail = "";
    try {
      const ran = await ci.runner({ name: "re-apply", command: REFRESH_SCRIPT, env, config: { retries: { limit: 1, delay: 15_000 }, timeout: 5 * 60_000 } });
      const out = typeof ran.logs.stdout === "string" ? ran.logs.stdout : "";
      if (out.includes("CANON_REFRESH_PUSHED")) outcome = "pushed";
      else if (out.includes("CANON_REFRESH_CONFLICT")) {
        outcome = "conflict";
        detail = `in ${out.slice(out.indexOf("CANON_REFRESH_CONFLICT") + 22).trim().split(/\s+/).join(", ") || "the change"}`;
      }
    } catch (err) {
      detail = isCiRunnerFailure(err) ? err.message : String(err);
    }
    await step.do("record refresh", () => referee.refreshed(repo, outcome, detail));
  }
}

// Started by the judge when several Ready claims may land at once: a merge train. The judge forked the train's attempt
// from canon; this applies each rider's own change to it in order (one that doesn't apply cleanly on the others is
// dropped and lands on its own), commits a canon.json with every rider's fact, and pushes. The push event then judges
// the combined code as one: every canon fact and every rider's fact must hold.
export class TrainAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const referee = refereeForRepo(this.env, repo);
    let env: Record<string, string> | null;
    try {
      env = await step.do("train job", async () => {
        const job = await referee.trainJob(repo);
        return job ? (Object.fromEntries(Object.entries(job)) as Record<string, string>) : null;
      });
    } catch (err) {
      await step.do("record train", () => referee.trainBuilt(repo, "failed", [], String(err)));
      return;
    }
    if (!env) return;
    let outcome: "pushed" | "failed" = "failed";
    let included: string[] = [];
    let detail = "";
    try {
      const ran = await ci.runner({ name: "build train", command: TRAIN_SCRIPT, env, config: { retries: { limit: 1, delay: 15_000 }, timeout: 5 * 60_000 } });
      const out = typeof ran.logs.stdout === "string" ? ran.logs.stdout : "";
      const pushed = out.match(/CANON_TRAIN_PUSHED([^\n]*)/);
      if (pushed) {
        outcome = "pushed";
        included = pushed[1].trim().split(/\s+/).filter(Boolean);
      } else detail = out.includes("CANON_TRAIN_EMPTY") ? "no rider's change applied cleanly on canon" : "the train script didn't push";
    } catch (err) {
      detail = isCiRunnerFailure(err) ? err.message : String(err);
    }
    await step.do("record train", () => referee.trainBuilt(repo, outcome, included, detail));
  }
}

// Checks that are checked. Started by the judge when a claim is Ready: in the attempt's checkout, deliberately break its
// own change (drop a one-line guard, flip a comparison, swap an error status for 200), at most six ways, and build each
// break as a preview of its own. The judge then runs the facts on every one: a break no fact notices is code no check
// covers. The previews are deleted afterwards.
export class MutateAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo, sha } = event.payload;
    const referee = refereeForRepo(this.env, repo);
    const files = await step.do("mutation job", async () => await referee.mutationJob(repo));
    if (!files) return;
    const prefix = `${repo}-mut`;
    let built: Array<{ file: string; line: number; op: string; before: string; after: string; preview: string | null }> = [];
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] } });
      const ran = await deps.runner({
        name: "build mutants",
        command: MUTANT_SCRIPT,
        env: { FILES: btoa(files), PREFIX: prefix, MAX: "6", MUTATOR: btoa(MUTATOR_JS) },
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
        config: { retries: { limit: 0, delay: 1_000 }, timeout: 12 * 60_000 },
      });
      const out = typeof ran.logs.stdout === "string" ? ran.logs.stdout : "";
      const line = out.split("\n").find((l) => l.startsWith("CANON_MUTANTS "));
      built = line ? JSON.parse(line.slice("CANON_MUTANTS ".length)) : [];
    } catch {
      built = [];
    }
    await step.do("judge mutants", { timeout: "15 minutes" }, () => referee.mutantsBuilt(repo, sha, built));
    try {
      await ci.runner({
        name: "delete mutant previews",
        command: built.filter((m) => m.preview).map((m) => `npx wrangler preview delete --name ${m.preview} >/dev/null 2>&1 || true`).join("\n") || "true",
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
      });
    } catch {
      // Leftover previews are harmless; scripts/reset-project.sh removes them too.
    }
  }
}

// In the attempt's checkout: list the lines the attempt added (against FILES, its changed files where it forked), make up to MAX simple
// breaks of them, and build each as a preview named PREFIX<n>, restoring the file after each. The generator is a
// small Node script (MUTATOR_JS, passed base64) so no shell quoting touches it; it prints one CANON_MUTANTS JSON line.
const MUTATOR_JS = String.raw`const fs = require("fs");
const [cmd, arg] = process.argv.slice(2);
const MAX = +process.env.MAX || 6;
if (cmd === "gen") {
  // The lines the attempt added: lines of each changed file that its forked-from version doesn't have.
  const files = JSON.parse(fs.readFileSync("/tmp/canon-mut-files.json", "utf8"));
  const added = [];
  for (const f of files) {
    if (!fs.existsSync(f.path)) continue;
    const before = f.b64 ? Buffer.from(f.b64, "base64").toString("utf8").split("\n") : [];
    const left = new Map();
    for (const l of before) left.set(l, (left.get(l) || 0) + 1);
    fs.readFileSync(f.path, "utf8").split("\n").forEach((text, i) => {
      const n = left.get(text) || 0;
      if (n) left.set(text, n - 1); else added.push({ file: f.path, line: i + 1, text });
    });
  }
  const out = [], used = new Set();
  const add = (a, op, after) => { const k = a.file + ":" + a.line; if (used.has(k)) return; used.add(k); out.push({ file: a.file, line: a.line, op, before: a.text.trim(), after: after.trim() }); };
  for (const a of added) {
    const t = a.text, s = t.trim();
    if (!s || s.startsWith("//") || s.startsWith("*")) continue;
    if (/^if\s*\(.*\)\s*return\b.*;$/.test(s)) { add(a, "removed the guard", ""); continue; }
    const st = /\b(409|400|403|404|422)\b/.exec(t);
    if (st && /status|Response/.test(t)) { add(a, st[1] + " \u2192 200", t.replace(st[1], "200")); continue; }
    for (const [f, r] of [["!==", "==="], ["===", "!=="], [">=", ">"], ["<=", "<"], [" > ", " >= "], [" < ", " <= "], ["&&", "||"]]) {
      if (t.includes(f)) { add(a, f.trim() + " \u2192 " + r.trim(), t.replace(f, r)); break; }
    }
  }
  fs.writeFileSync("/tmp/canon-mutants.json", JSON.stringify(out.slice(0, MAX)));
  console.log(out.slice(0, MAX).length);
} else if (cmd === "apply") {
  const m = JSON.parse(fs.readFileSync("/tmp/canon-mutants.json", "utf8"))[+arg];
  fs.copyFileSync(m.file, "/tmp/canon-mut-backup");
  const L = fs.readFileSync(m.file, "utf8").split("\n");
  L[m.line - 1] = m.after ? L[m.line - 1].replace(m.before, m.after) : "";
  fs.writeFileSync(m.file, L.join("\n"));
} else if (cmd === "restore") {
  const m = JSON.parse(fs.readFileSync("/tmp/canon-mutants.json", "utf8"))[+arg];
  fs.copyFileSync("/tmp/canon-mut-backup", m.file);
} else if (cmd === "report") {
  const ms = JSON.parse(fs.readFileSync("/tmp/canon-mutants.json", "utf8"));
  const ok = new Set(fs.readFileSync("/tmp/canon-mutants.out", "utf8").split("\n").filter((l) => l.endsWith(" ok")).map((l) => +l.split(" ")[0]));
  console.log("CANON_MUTANTS " + JSON.stringify(ms.map((m, i) => ({ ...m, preview: ok.has(i) ? process.env.PREFIX + i : null }))));
}
`;
const MUTANT_SCRIPT = [
  `set +e`,
  `printf %s "$MUTATOR" | base64 -d > /tmp/canon-mutator.js`,
  `printf %s "$FILES" | base64 -d > /tmp/canon-mut-files.json`,
  `n=$(node /tmp/canon-mutator.js gen)`,
  `i=0; : > /tmp/canon-mutants.out`,
  `while [ "$i" -lt "\${n:-0}" ]; do`,
  `  node /tmp/canon-mutator.js apply "$i"`,
  `  if npx wrangler preview --name "$PREFIX$i" --json > /tmp/canon-mut-$i.log 2>&1; then echo "$i ok" >> /tmp/canon-mutants.out; else echo "$i no" >> /tmp/canon-mutants.out; fi`,
  `  node /tmp/canon-mutator.js restore "$i"`,
  `  i=$((i+1))`,
  `done`,
  `node /tmp/canon-mutator.js report`,
].join("\n");

// Runs in the CI container: applies each rider's change (everything since it forked, except canon.json) in order.
const TRAIN_SCRIPT = [
  `set -e`,
  `rm -rf /tmp/canon-train && git init -q /tmp/canon-train && cd /tmp/canon-train`,
  `git config user.name "Canon judge" && git config user.email "judge@canon.rodeo"`,
  `git fetch -q "$NEW_URL" main && git checkout -q -B main FETCH_HEAD`,
  `printf %s "$PARTS" | base64 -d > /tmp/canon-train-parts.json`,
  `node -e 'for (const p of require("/tmp/canon-train-parts.json")) console.log([p.claim, p.url, p.base, p.head].join(" "))' > /tmp/canon-train-list`,
  `included=""`,
  `while read -r claim url base head; do`,
  `  git fetch -q "$url" main`,
  `  git diff --binary "$base" "$head" -- . ':(exclude)canon.json' > /tmp/canon-train.patch`,
  `  if [ ! -s /tmp/canon-train.patch ]; then echo "CANON_TRAIN_DROPPED $claim (no change)"; continue; fi`,
  `  if git apply --3way --index /tmp/canon-train.patch >/dev/null 2>&1; then`,
  `    git commit -q -m "merge train: $claim" --trailer "Canon-Claim: $claim"; included="$included $claim"`,
  `  else git reset -q --hard HEAD; echo "CANON_TRAIN_DROPPED $claim"; fi`,
  `done < /tmp/canon-train-list`,
  `if [ -z "$included" ]; then echo CANON_TRAIN_EMPTY; exit 0; fi`,
  // canon.json: canon's own, with every included rider's fact moved from the backlog into the facts.
  `printf %s "$CANON_BASE" | base64 -d > /tmp/canon-train-base.json && printf %s "$FACTS" | base64 -d > /tmp/canon-train-facts.json`,
  `INCLUDED="$included" node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/tmp/canon-train-base.json","utf8"));const f=JSON.parse(fs.readFileSync("/tmp/canon-train-facts.json","utf8"));for(const id of process.env.INCLUDED.trim().split(/ +/)){const d=f[id];if(!d)continue;if(Array.isArray(c.backlog))c.backlog=c.backlog.filter(b=>b.id!==d.id);if(!c.facts.some(x=>x.id===d.id))c.facts.push(d)}if(c.backlog&&!c.backlog.length)delete c.backlog;fs.writeFileSync("canon.json",JSON.stringify(c,null,2)+"\\n")'`,
  `git add canon.json && git commit -q -m "canon: merge train of$included" --trailer "Canon-Train: yes"`,
  `git push -q "$NEW_URL" HEAD:main`,
  `echo "CANON_TRAIN_PUSHED$included"`,
].join("\n");

// Runs in the CI container. The URLs carry short-lived tokens: read for the old attempt, write for the new one.
const REFRESH_SCRIPT = [
  `set -e`,
  `rm -rf /tmp/canon-refresh && git init -q /tmp/canon-refresh && cd /tmp/canon-refresh`,
  `git config user.name "$AGENT" && git config user.email "$AGENT@canon.local"`,
  // The old attempt's change: everything since it forked, except canon.json (the judge writes that one).
  `git fetch -q "$OLD_URL" "$OLD_HEAD"`,
  `git diff --binary "$OLD_BASE" "$OLD_HEAD" -- . ':(exclude)canon.json' > /tmp/canon-refresh.patch`,
  `git fetch -q "$NEW_URL" main && git checkout -q -B main FETCH_HEAD`,
  `printf %s "$CANON_JSON" | base64 -d > canon.json`,
  `commit() { git commit -q -m "$1" --trailer "Canon-Fact: $FACT" --trailer "Canon-Claim: $CLAIM" --trailer "Canon-Agent: $AGENT"; }`,
  `git add canon.json && commit "canon: claim \"$FACT\""`,
  `if [ -s /tmp/canon-refresh.patch ]; then`,
  `  if ! git apply --3way /tmp/canon-refresh.patch >/dev/null 2>&1; then echo CANON_REFRESH_CONFLICT $(git diff --name-only --diff-filter=U); exit 0; fi`,
  `  git add -A && commit "Re-apply $OLD_ID on canon $CANON_SEQ"`,
  `fi`,
  `git push -q "$NEW_URL" HEAD:main 2>&1 | sed 's#//x:[^@]*@#//x:***@#g'`,
  `git ls-remote "$NEW_URL" refs/heads/main | grep -q "$(git rev-parse HEAD)" && echo CANON_REFRESH_PUSHED`,
].join("\n");

// `wrangler preview --json` prints { preview: { urls }, deployment: { urls } }. The Preview is
// already per commit, so its stable URL is the one to keep. That output comes from the attempt's own checkout, so
// only a workers.dev address for this Preview is believed; anything else falls back to the template.
function previewUrlFrom(logs: CiRunnerResult["logs"], previewName: string): string | null {
  const url = previewUrlIn(logs);
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.startsWith(`${previewName}-`) && host.endsWith(".workers.dev") ? url : null;
  } catch {
    return null;
  }
}

function previewUrlIn(logs: CiRunnerResult["logs"]): string | null {
  if (typeof logs.stdout !== "string") return null;
  const out = logs.stdout;
  try {
    const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as {
      preview?: { urls?: string[] };
      deployment?: { urls?: string[] };
    };
    const url = json.preview?.urls?.[0] ?? json.deployment?.urls?.[0];
    if (url) return url;
  } catch {
    // not JSON; fall through to the first workers.dev URL in the output
  }
  return out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
}
