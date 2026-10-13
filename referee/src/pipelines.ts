import { CIWorkflow, isCiRunnerFailure, type CiContext, type CiParams, type CiRunnerResult, type CloudflareArtifacts } from "@cloudflare/ci";
import { commandFailure, commandScript, exitedNonZero, heldOnBase, parseCommandResults, PLATFORM_RETRIES, type Novelty } from "./commands";
import type { CheckResult } from "./protocol";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { refereeForRepo } from "./stub";

// Started by the cf.artifacts.repo.pushed trigger for every repo in the namespace.
// Builds the pushed attempt as a Workers Preview, then hands it to the referee to judge.
// 120 turns 15 seconds apart, then 180 a minute apart: about 3.5 hours, and 600 of a Workflow's steps at most.
const ADMISSION_TURNS = 300;

export class VerifyAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo, sha, branch } = event.payload;
    if (branch !== "main") return;
    const referee = refereeForRepo(this.env, repo);
    const attemptId = await step.do("register push", () => referee.pushed(repo, sha));
    if (!attemptId) return;
    // Admission: at most a few verifications per project build at once; this one waits its turn. A newer push of the
    // same attempt makes this one pointless: it stops here. Waiting never turns into permission: a commit that isn't
    // admitted in about three and a half hours is not verified at all; it gets a platform error the judge retries.
    let admitted = false;
    for (let turn = 0; turn < ADMISSION_TURNS && !admitted; turn++) {
      const turnFor = await step.do(`slot ${turn}`, () => referee.admit(repo, sha));
      if (turnFor === "stale") return;
      if (turnFor === "go") admitted = true;
      else await step.sleep(`queued ${turn}`, turn < 120 ? "15 seconds" : "1 minute");
    }
    if (!admitted) {
      await step.do("never admitted", () => referee.couldNotJudge(repo, sha, "it waited about three and a half hours for a verification slot and never got one, so nothing was built or checked"));
      return;
    }

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

    // A newer push of the same attempt arrived while this one built: its verdict would be replaced at once, so stop
    // here and give the slot back instead of running every check for nothing.
    if (await step.do("still current", () => referee.superseded(repo, sha))) return;

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
    // The release deploys exactly the commit canon #seq's acceptance authorized, and only while #seq is still canon and
    // this run holds its lease (the fence, renewed before every step that changes a Worker; see Referee.fence).
    const holder = event.instanceId;
    const sha = event.payload.sha;
    type Fence = { go: true; until: number } | { go: false; why: string; settle: boolean };
    const fence = async (label: string): Promise<Fence> => JSON.parse(await step.do(label, async () => JSON.stringify(await referee.fence(seq, sha, holder))));
    const first = await fence("authorized");
    if (!first.go) {
      if (first.settle) await step.do("refused", () => referee.releaseRefused(seq, first.why));
      return;
    }
    // Every container command that changes a Worker runs under the lease's absolute deadline: each wrangler call refuses
    // to start once less than a minute is left, and `timeout` kills it if it's still running a minute before the lease
    // runs out, so nothing this run starts can still be writing after the judge could have fenced it out.
    let deadline = first.until;
    const fenced = async (label: string) => {
      const f = await fence(`fence: ${label}`);
      if (!f.go) throw new Error(`fenced out before ${label}: ${f.why}`);
      deadline = f.until;
    };
    // `w` recomputes the time left right before every wrangler call, so in a script that first clones and installs,
    // a slow start can't stretch a later call past the lease: each call is bounded by the absolute deadline.
    const inTime = () => `D=${Math.floor(deadline / 1000)}; w() { T=$(( D - $(date +%s) - 60 )); [ "$T" -gt 0 ] || exit 3; timeout "$T" npx wrangler "$@"; }; [ $(( D - $(date +%s) - 60 )) -gt 0 ] || exit 3; `;
    const wrangler = "w";
    let ok = true;
    let versionId: string | null = null;
    let candidateRan = false;
    const project = repo.slice(0, repo.lastIndexOf("-"));
    const creds = { accountId: this.env.CLOUDFLARE_ACCOUNT_ID };
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] } });
      // Each project deploys under its own Worker name (project above), so projects never share a production app.
      // A candidate left dirty (unreleased code ran on it and it couldn't be rebuilt) is never reused as it is: rebuild
      // it from production's code first, or stop here as a platform failure.
      const dirty = await step.do("candidate state", () => referee.candidateDirty());
      if (dirty) {
        await fenced("candidate rebuild first");
        const job = await step.do("candidate rebuild first job", async () => {
          const j = await referee.candidateResetJob(seq, holder, true);
          return j ? (Object.fromEntries(Object.entries(j)) as Record<string, string>) : null;
        });
        if (!job) throw new Error(`the release candidate is dirty (${dirty}) and there is no released code to rebuild it from`);
        await ci.runner({ name: "rebuild dirty release candidate", command: `${inTime()}${RESET_SCRIPT(project, wrangler)}`, env: job, cloudflareCredentials: creds, config: { retries: { limit: 1, delay: 10_000 }, timeout: 8 * 60_000 } });
        await step.do("candidate clean", () => referee.markCandidate(null));
      }
      // Step one, the release candidate: the whole commit on its own Worker with production's config, so every fact
      // runs on all of its code (Durable Objects included) before production is touched.
      await fenced("release candidate");
      candidateRan = true;
      await deps.runner({ name: "deploy release candidate", command: `${inTime()}${wrangler} deploy --name ${project}-candidate`, cloudflareCredentials: creds });
      const candidateOk = await step.do("check release candidate", { timeout: "10 minutes" }, async () => await referee.candidateCheck(seq));
      if (!candidateOk) throw new Error("held back: the release candidate broke a fact");
      // The rollback rehearsal, for a change that touches stored data (or couldn't be fully inspected): the code
      // production runs now goes onto the release candidate, over the data this release's code just wrote, and the facts
      // that were canon before must still hold. That's what an automatic rollback would do; now it's known in advance.
      await fenced("rollback rehearsal");
      const rehearsal = await step.do("rehearsal job", async () => {
        const job = await referee.rehearsalJob(seq, holder);
        return job ? (Object.fromEntries(Object.entries(job)) as Record<string, string>) : null;
      });
      if (rehearsal) {
        let deployedPrev = true;
        let why = "";
        try {
          await ci.runner({ name: "rehearse rollback", command: `${inTime()}${REHEARSE_SCRIPT(project, wrangler)}`, env: rehearsal, cloudflareCredentials: creds, config: { retries: { limit: 1, delay: 10_000 }, timeout: 8 * 60_000 } });
        } catch (err) {
          deployedPrev = false;
          why = isCiRunnerFailure(err) ? err.message : String(err);
        }
        const goOn = await step.do("check rollback rehearsal", { timeout: "10 minutes" }, async () => await referee.rehearsalCheck(seq, holder, deployedPrev, why));
        if (!goOn) throw new Error("held back: its rollback rehearsal didn't pass");
      }
      // Step two: upload the exact commit as a new Worker version that serves nobody yet, and let the judge (the one
      // writer of production's deployment, which checks this run's lease right before each write) put it in front of
      // traffic. For a Worker without Durable Objects the judge stages it at 0% and smoke-tests every fact on the
      // production URL against it first; with Durable Objects an object runs one version at a time, so a 0% test can't
      // reach that code, and the release candidate (a full copy, its own persistent data) was the gate.
      const objects = await deps.runner({ name: "durable objects?", command: `grep -qs '"durable_objects"' wrangler.jsonc wrangler.json && echo CANON_HAS_DO || true` });
      const hasObjects = typeof objects.logs.stdout === "string" && objects.logs.stdout.includes("CANON_HAS_DO");
      let atomic = false;
      await fenced("production");
      const run = await deps.runner({ name: "upload version", command: `${inTime()}${wrangler} versions upload --name ${project}`, cloudflareCredentials: creds }).catch((err) => {
        // Only a Durable Object class change may skip the judge's write: Cloudflare can't upload it as a version (it's
        // applied atomically by a deploy). Any other upload failure stops the release.
        const why = isCiRunnerFailure(err) ? err.message : String(err);
        if (!/migration|lifecycle|durable object class/i.test(why)) throw err;
        atomic = true;
        return null;
      });
      if (atomic || !run) {
        // A class change deploys atomically from here, still under the lease's deadline (refused late, killed at it).
        await fenced("production deploy");
        const deployed = await deps.runner({ name: "deploy", command: `${inTime()}${wrangler} deploy --name ${project}`, cloudflareCredentials: creds });
        const out = typeof deployed.logs.stdout === "string" ? deployed.logs.stdout : "";
        versionId = out.match(/Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
      } else {
        const out = typeof run.logs.stdout === "string" ? run.logs.stdout : "";
        versionId = out.match(/Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
        if (!versionId) throw new Error("no version id in the upload output");
        const id = versionId;
        await fenced("release gate");
        const released = await step.do("release gate", { timeout: "10 minutes" }, async () => (await referee.gate(seq, id, holder, !hasObjects)).released);
        ok = released;
      }
    } catch {
      ok = false;
    }
    // Not shipped after this release's code ran on the candidate, and it touched stored data: rebuild the candidate from
    // production's code while this run still holds the release, so no later release is judged on data production
    // never had. Best effort, and recorded either way.
    if (!ok && candidateRan) {
      try {
        await fenced("candidate rebuild");
        const job = await step.do("candidate rebuild job", async () => {
          const j = await referee.candidateResetJob(seq, holder);
          return j ? (Object.fromEntries(Object.entries(j)) as Record<string, string>) : null;
        });
        if (!job) await step.do("candidate left dirty", () => referee.markCandidate(`canon #${seq}'s code ran on it and there was no released code to rebuild it from`));
        if (job) {
          let rebuilt = true;
          let why = "rebuilt from production's code (the candidate Worker and its Durable Objects deleted, then redeployed)";
          try {
            await ci.runner({ name: "rebuild release candidate", command: `${inTime()}${RESET_SCRIPT(project, wrangler)}`, env: job, cloudflareCredentials: creds, config: { retries: { limit: 0, delay: 1_000 }, timeout: 8 * 60_000 } });
          } catch (err) {
            rebuilt = false;
            why = `couldn't rebuild: ${isCiRunnerFailure(err) ? err.message : String(err)}`;
          }
          await step.do("candidate rebuilt", () => referee.candidateReset(seq, rebuilt, why));
        }
      } catch {
        // Fenced out before it could rebuild: the candidate stays marked dirty, and the next release rebuilds it first.
        await step.do("candidate left dirty", () => referee.markCandidate(`canon #${seq}'s code ran on it and its run was fenced out before rebuilding it`));
      }
    }
    await step.do("record promotion", () => referee.promoted(seq, ok, versionId, holder));
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

// Runs in the CI container: the rollback rehearsal. Checks out the code production runs now (PREV_URL at PREV_SHA, a
// read-only token) and deploys it onto the release candidate, which this release's code has just run on.
const REHEARSE_SCRIPT = (project: string, wrangler: string) => [
  `set -e`,
  `rm -rf /tmp/canon-prev && git clone -q "$PREV_URL" /tmp/canon-prev && cd /tmp/canon-prev && git checkout -q "$PREV_SHA"`,
  `npm ci --no-audit --no-fund --ignore-scripts >/dev/null`,
  `${wrangler} deploy --name ${project}-candidate`,
].join(" && ");

// Runs in the CI container: rebuilds the release candidate from production's code. Deleting the Worker deletes its
// Durable Objects; the namespace takes a moment to go, so the fresh deploy is retried.
const RESET_SCRIPT = (project: string, wrangler: string) => [
  `set -e`,
  `(${wrangler} delete --name ${project}-candidate --force >/dev/null 2>&1 || true)`,
  `rm -rf /tmp/canon-prev && git clone -q "$PREV_URL" /tmp/canon-prev && cd /tmp/canon-prev && git checkout -q "$PREV_SHA"`,
  `npm ci --no-audit --no-fund --ignore-scripts >/dev/null`,
  `for i in 1 2 3 4 5; do ${wrangler} deploy --name ${project}-candidate && exit 0; sleep 15; done; exit 1`,
].join(" && ");

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
        detail = `in ${(out.match(/CANON_REFRESH_CONFLICT([^\n]*)/)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).join(", ") || "the change"}`;
        // Bounded repair: the judge's model resolves the markers once; the result is pushed and judged like any push.
        const files: Record<string, string> = {};
        for (const m of out.matchAll(/CANON_CONFLICT_FILE (\S+) (\S+)/g)) files[m[1]] = new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
        if (Object.keys(files).length) {
          const resolved = await step
            .do("repair", { timeout: "8 minutes", retries: { limit: 0, delay: 1_000 } }, async () => {
              const r = await referee.repairConflict(repo, files);
              return r ? JSON.stringify(r) : null;
            })
            .catch(() => null);
          if (resolved) {
            const bytes = new TextEncoder().encode(resolved);
            let bin = "";
            for (const b of bytes) bin += String.fromCharCode(b);
            const again = await ci.runner({ name: "re-apply (repaired)", command: REFRESH_SCRIPT, env: { ...env, RESOLVED: btoa(bin) }, config: { retries: { limit: 1, delay: 15_000 }, timeout: 5 * 60_000 } });
            const out2 = typeof again.logs.stdout === "string" ? again.logs.stdout : "";
            if (out2.includes("CANON_REFRESH_PUSHED")) {
              outcome = "pushed";
              detail = "repaired";
            }
          }
        }
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
    if (!files) {
      await step.do("no source changes", () => referee.mutantsBuilt(repo, sha, [], "no-source"));
      return;
    }
    const prefix = `${repo}-mut`;
    let built: Array<{ file: string; line: number; op: string; before: string; after: string; preview: string | null }> = [];
    let failed = false;
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] } });
      const ran = await deps.runner({
        name: "build mutants",
        command: MUTANT_SCRIPT,
        env: { FILES: btoa(files), PREFIX: prefix, MAX: "8", MUTATOR: btoa(MUTATOR_JS) },
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
        config: { retries: { limit: 0, delay: 1_000 }, timeout: 12 * 60_000 },
      });
      const out = typeof ran.logs.stdout === "string" ? ran.logs.stdout : "";
      const line = out.split("\n").find((l) => l.startsWith("CANON_MUTANTS "));
      built = line ? JSON.parse(line.slice("CANON_MUTANTS ".length)) : [];
      if (!line) failed = true;
    } catch {
      built = [];
      failed = true;
    }
    // No mutants because the platform failed is not "nothing to break": the judge records it as unavailable evidence.
    await step.do("judge mutants", { timeout: "15 minutes" }, () => referee.mutantsBuilt(repo, sha, built, built.length ? undefined : failed ? "build-failed" : "no-mutants"));
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
  // Breaks that matter most go first (MAX keeps the first few): stored data, retries and failure paths, then guards,
  // error statuses and comparisons. One break per line.
  const out = [], used = new Set();
  const add = (a, op, after, prio) => { const k = a.file + ":" + a.line; if (used.has(k)) return; used.add(k); out.push({ file: a.file, line: a.line, op, before: a.text.trim(), after: after.trim(), prio }); };
  for (const a of added) {
    const t = a.text, s = t.trim();
    if (!s || s.startsWith("//") || s.startsWith("*")) continue;
    // Retries and duplicates: what happens when the same write arrives twice.
    const acc = /(\w+)\s*=\s*\1\s*\+\s*excluded\.\1/.exec(t);
    if (acc) { add(a, "a repeated write overwrites instead of adding", t.replace(acc[0], acc[1] + " = excluded." + acc[1]), 0); continue; }
    if (/INSERT OR IGNORE/i.test(t)) { add(a, "a duplicate replaces the original", t.replace(/INSERT OR IGNORE/i, "INSERT OR REPLACE"), 0); continue; }
    if (/INSERT OR REPLACE/i.test(t)) { add(a, "a duplicate is silently dropped", t.replace(/INSERT OR REPLACE/i, "INSERT OR IGNORE"), 0); continue; }
    // Concurrency and integrity: the constraint that stops two writers both winning.
    const pk = /,\s*(PRIMARY KEY|UNIQUE)\s*\([^)]*\)/i.exec(t);
    if (pk) { add(a, "dropped the uniqueness constraint", t.replace(pk[0], ""), 0); continue; }
    if (/\bUNIQUE\b/i.test(t) && /CREATE|ALTER/i.test(t)) { add(a, "dropped the uniqueness constraint", t.replace(/\s*\bUNIQUE\b/i, ""), 0); continue; }
    // Migrations: re-runnable, and safe for the rows already there.
    if (/CREATE TABLE IF NOT EXISTS/i.test(t)) { add(a, "the migration isn't safe to re-run", t.replace(/CREATE TABLE IF NOT EXISTS/i, "CREATE TABLE"), 0); continue; }
    const def = /\s+DEFAULT\s+('[^']*'|"[^"]*"|[\w.-]+)/i.exec(t);
    if (def && /ADD COLUMN|CREATE TABLE/i.test(t)) { add(a, "existing rows get no default", t.replace(def[0], ""), 0); continue; }
    // Failure paths: an error that should stop the request, swallowed.
    if (/^throw\b/.test(s)) { add(a, "swallowed the failure", "", 1); continue; }
    if (/^if\s*\(.*\)\s*throw\b.*;$/.test(s)) { add(a, "removed the check that fails the request", "", 1); continue; }
    if (/^if\s*\(.*\)\s*return\b.*;$/.test(s)) { add(a, "removed the guard", "", 1); continue; }
    const st = /\b(409|400|403|404|422)\b/.exec(t);
    if (st && /status|Response/.test(t)) { add(a, st[1] + " \u2192 200", t.replace(st[1], "200"), 1); continue; }
    for (const [f, r] of [["!==", "==="], ["===", "!=="], [">=", ">"], ["<=", "<"], [" > ", " >= "], [" < ", " <= "], ["&&", "||"]]) {
      if (t.includes(f)) { add(a, f.trim() + " \u2192 " + r.trim(), t.replace(f, r), 2); break; }
    }
  }
  const picked = out.map((m, i) => [m, i]).sort((x, y) => x[0].prio - y[0].prio || x[1] - y[1]).slice(0, MAX).map(([m]) => { const { prio, ...rest } = m; return rest; });
  fs.writeFileSync("/tmp/canon-mutants.json", JSON.stringify(picked));
  console.log(picked.length);
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
  `  git fetch -q "$url" main || { echo "CANON_TRAIN_DROPPED $claim (fetch)"; continue; }`,
  `  git diff --binary "$base" "$head" -- . ':(exclude)canon.json' > /tmp/canon-train.patch || { echo "CANON_TRAIN_DROPPED $claim (diff)"; continue; }`,
  `  if [ ! -s /tmp/canon-train.patch ]; then echo "CANON_TRAIN_DROPPED $claim (no change)"; continue; fi`,
  `  if git apply --3way --index /tmp/canon-train.patch >/dev/null 2>&1; then`,
  `    if git commit -q -m "merge train: $claim" --trailer "Canon-Claim: $claim"; then included="$included $claim"; else git reset -q --hard HEAD; echo "CANON_TRAIN_DROPPED $claim (nothing new)"; fi`,
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
  `  if git apply --3way /tmp/canon-refresh.patch >/dev/null 2>&1; then`,
  `    git add -A && commit "Re-apply $OLD_ID on canon $CANON_SEQ"`,
  // A text conflict. With RESOLVED (the judge's repair, second pass) write the resolved files; otherwise hand the
  // conflicted files to the judge and stop.
  `  elif [ -n "\${RESOLVED:-}" ]; then`,
  `    printf %s "$RESOLVED" | base64 -d > /tmp/canon-resolved.json`,
  `    node -e 'const fs=require("fs");for(const [p,t] of Object.entries(JSON.parse(fs.readFileSync("/tmp/canon-resolved.json","utf8"))))fs.writeFileSync(p,t)'`,
  `    git add -A && commit "Re-apply $OLD_ID on canon $CANON_SEQ (a text conflict resolved by the judge's repair model; every fact decides)"`,
  `  else`,
  `    files=$(git diff --name-only --diff-filter=U); echo CANON_REFRESH_CONFLICT $files`,
  `    for f in $files; do [ "$(wc -c < "$f")" -lt 150000 ] && echo "CANON_CONFLICT_FILE $f $(base64 -w0 "$f")"; done`,
  `    exit 0`,
  `  fi`,
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
