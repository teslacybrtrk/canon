import { CIWorkflow, isCiRunnerFailure, type CiContext, type CiParams, type CiRunnerResult, type CloudflareArtifacts } from "@cloudflare/ci";
import type { CheckResult } from "./protocol";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { refereeForRepo } from "./stub";

// Started by the cf.artifacts.repo.pushed trigger for every repo in the namespace.
// Builds the pushed world as a Workers Preview, then hands it to the referee to judge.
export class VerifyWorld extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo, sha, branch } = event.payload;
    if (branch !== "main") return;
    const referee = refereeForRepo(this.env, repo);
    const worldId = await step.do("register push", () => referee.pushed(repo, sha));
    if (!worldId) return;

    // One Preview per pushed commit. Within a single Preview, Durable Objects always run the
    // latest push, so only a Preview of its own keeps a judged attempt exactly as it was.
    const previewName = `${repo}-${sha.slice(0, 7)}`;
    let previewUrl: string;
    let deps: CiRunnerResult;
    try {
      deps = await ci.runner({
        name: "install",
        command: "npm ci --no-audit --no-fund",
        cache: { inputs: ["package-lock.json"] },
        config: { retries: { limit: 1, delay: 5_000 } },
      });
      const preview = await deps.runner({
        name: "preview",
        command: `npx wrangler preview --name ${previewName} --json`,
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
        config: { retries: { limit: 1, delay: 5_000 } },
      });
      previewUrl = previewUrlFrom(preview.logs) ?? this.env.PREVIEW_URL_TEMPLATE.replace("{name}", previewName);
    } catch (err) {
      const detail = isCiRunnerFailure(err) ? err.message : String(err);
      await step.do("build failed", () => referee.buildFailed(repo, sha, detail));
      return;
    }

    // Command facts (lint, types, tests, budgets) run on this commit's checkout, each in its own
    // container from the installed snapshot. The commands come from canon, never from the world.
    const commands = await step.do("command facts", () => referee.commandsFor(repo, sha));
    // In parallel: each runs in its own container from the same snapshot, and each failure is caught on its own.
    const results: Record<string, CheckResult> = {};
    await Promise.all(
      commands.map(async ({ factId, run }) => {
        const started = Date.now();
        // A command that exits non-zero is a verdict. A platform error (container or Workflows
        // trouble) is not: retry it in a fresh container, and never blame the code for it.
        for (let attempt = 0; ; attempt++) {
          try {
            const name = attempt ? `fact ${factId} (retry ${attempt})` : `fact ${factId}`;
            await deps.runner({ name, command: run, config: { retries: { limit: 0, delay: 1_000 }, timeout: 5 * 60_000 } });
            results[factId] = { held: true, detail: "ok", ms: Date.now() - started };
            return;
          } catch (err) {
            if (exitedNonZero(err)) {
              results[factId] = { held: false, detail: commandFailure(run, err), ms: Date.now() - started };
              return;
            }
            if (attempt >= 2) {
              results[factId] = { held: false, detail: `\`${run}\` could not run (platform error, not your code): ${String((err as Error).message).slice(0, 120)}. Push again.`, ms: Date.now() - started };
              return;
            }
          }
        }
      }),
    );

    await step.do("judge", { retries: { limit: 4, delay: 10_000, backoff: "linear" }, timeout: 5 * 60_000 }, async () => {
      await referee.judge(repo, sha, previewUrl, results);
    });
  }
}

// Started by the referee when a human accepts a fact. Deploys the accepted world to production.
export class PromoteWorld extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo } = event.payload;
    const seq = Number(event.instanceId.match(/^promote-(\d+)-/)?.[1] ?? 0);
    let ok = true;
    try {
      const deps = await ci.runner({ name: "install", command: "npm ci --no-audit --no-fund", cache: { inputs: ["package-lock.json"] } });
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

// `wrangler preview --json` prints { preview: { urls }, deployment: { urls } }. The Preview is
// already per commit, so its stable URL is the one to keep.
// The CI library reports a command's own failure as "<name> failed with exit code N".
function exitedNonZero(err: unknown): boolean {
  const text = isCiRunnerFailure(err) ? err.output : String((err as Error)?.message ?? err);
  return /failed with exit code \d+/.test(text);
}

// The useful part of a failed command for a verdict: the first "file:line:col rule" location if the
// tool printed one (lint and type errors do), plus its summary line; otherwise its last output lines.
function commandFailure(run: string, err: unknown): string {
  const raw = (isCiRunnerFailure(err) ? err.output : String(err)).replace(/\u001b\[[0-9;]*m/g, "");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("===") && !/failed with exit code/.test(l) && !/^[━─│]+$/.test(l));
  const location = lines.find((l) => /^[\w./-]+[:(]\d+[:,]\d+\)?[:\s]/.test(l))?.replace(/\s*(FIXABLE)?\s*[━─]{3,}.*$/, "");
  const summary = lines.find((l) => /^(Found \d+ (errors?|warnings?)|\d+ errors?)/i.test(l));
  const detail = [...new Set([location, summary].filter(Boolean))].join(" · ") || lines.slice(-2).join(" · ");
  return `\`${run}\` failed: ${detail.slice(0, 280) || "non-zero exit"}`;
}

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
