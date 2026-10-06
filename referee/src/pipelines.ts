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
      previewUrl = previewUrlFrom(preview.logs) ?? this.env.PREVIEW_URL_TEMPLATE.replace("{name}", previewName);
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

    await step.do("judge", { retries: { limit: 4, delay: 10_000, backoff: "linear" }, timeout: 5 * 60_000 }, async () => {
      await referee.judge(repo, sha, previewUrl, results, notNew);
    });
  }
}

// Started by the referee when a human accepts a fact. Deploys the accepted attempt to production.
export class PromoteAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const seq = Number(event.instanceId.match(/^promote-(\d+)-/)?.[1] ?? 0);
    let ok = true;
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund --ignore-scripts", cache: { inputs: ["package-lock.json"] } });
      // Each project deploys under its own Worker name, so projects never share a production app.
      const project = repo.slice(0, repo.lastIndexOf("-"));
      await deps.runner({
        name: "deploy",
        command: `npx wrangler deploy --name ${project}`,
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
      });
    } catch {
      ok = false;
    }
    await step.do("record promotion", () => refereeForRepo(this.env, repo).promoted(seq, ok));
  }
}

// Started by the judge when canon moved under an attempt. The judge already declared a new attempt from the current
// canon for the same agent and fact; this re-applies the old attempt's change there and pushes it (what `canon refresh`
// does on an agent's machine). The push event then judges it like any other. A text conflict goes back to the agent.
export class RefreshAttempt extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const referee = refereeForRepo(this.env, repo);
    const env = await step.do("refresh job", async () => {
      const job = await referee.refreshJob(repo);
      return job ? (Object.fromEntries(Object.entries(job)) as Record<string, string>) : null;
    });
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
  `T="--trailer Canon-Fact:$FACT --trailer Canon-Claim:$CLAIM --trailer Canon-Agent:$AGENT"`,
  `git commit -q -a -m "canon: claim \"$FACT\"" $T`,
  `if [ -s /tmp/canon-refresh.patch ]; then`,
  `  if ! git apply --3way /tmp/canon-refresh.patch >/dev/null 2>&1; then echo CANON_REFRESH_CONFLICT $(git diff --name-only --diff-filter=U); exit 0; fi`,
  `  git add -A && git commit -q -m "Re-apply $OLD_ID on canon $CANON_SEQ" $T`,
  `fi`,
  `git push -q "$NEW_URL" HEAD:main 2>&1 | sed 's#//x:[^@]*@#//x:***@#g'`,
  `git ls-remote "$NEW_URL" refs/heads/main | grep -q "$(git rev-parse HEAD)" && echo CANON_REFRESH_PUSHED`,
].join("\n");

// `wrangler preview --json` prints { preview: { urls }, deployment: { urls } }. The Preview is
// already per commit, so its stable URL is the one to keep.
function previewUrlFrom(logs: CiRunnerResult["logs"]): string | null {
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
