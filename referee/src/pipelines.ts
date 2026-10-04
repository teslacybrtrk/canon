import { CIWorkflow, isCiRunnerFailure, type CiContext, type CiParams, type CiRunnerResult, type CloudflareArtifacts } from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";

// Started by the cf.artifacts.repo.pushed trigger for every repo in the namespace.
// Builds the pushed world as a Workers Preview, then hands it to the referee to judge.
export class VerifyWorld extends CIWorkflow<CloudflareArtifacts, Env> {
  protected async pipeline(event: WorkflowEvent<CiParams<CloudflareArtifacts>>, step: WorkflowStep, ci: CiContext) {
    const { repo, sha, branch } = event.payload;
    if (branch !== "main") return;
    const referee = refereeFor(this.env, repo);
    const worldId = await step.do("register push", () => referee.pushed(repo, sha));
    if (!worldId) return;

    let previewUrl: string;
    try {
      const deps = await ci.runner({
        name: "install",
        command: "npm ci --no-audit --no-fund",
        cache: { inputs: ["package-lock.json"] },
        config: { retries: { limit: 1, delay: 5_000 } },
      });
      const preview = await deps.runner({
        name: "preview",
        command: `npx wrangler preview --name ${repo} --json`,
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
        config: { retries: { limit: 1, delay: 5_000 } },
      });
      previewUrl = previewUrlFrom(preview.logs) ?? this.env.PREVIEW_URL_TEMPLATE.replace("{name}", repo);
    } catch (err) {
      const detail = isCiRunnerFailure(err) ? err.message : String(err);
      await step.do("build failed", () => referee.buildFailed(repo, sha, detail));
      return;
    }

    await step.do("judge", { retries: { limit: 4, delay: 10_000, backoff: "linear" }, timeout: 5 * 60_000 }, async () => {
      await referee.judge(repo, sha, previewUrl);
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
      await deps.runner({
        name: "deploy",
        command: "npx wrangler deploy",
        cloudflareCredentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID },
      });
    } catch {
      ok = false;
    }
    await step.do("record promotion", () => refereeFor(this.env, repo).promoted(seq, ok));
  }
}

/** World repos are named "<project>-<suffix>"; one referee per project. */
export function refereeFor(env: Env, repo: string) {
  const project = repo.slice(0, repo.lastIndexOf("-"));
  return env.REFEREE.get(env.REFEREE.idFromName(project));
}

function previewUrlFrom(logs: CiRunnerResult["logs"]): string | null {
  if (typeof logs.stdout !== "string") return null;
  return logs.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
}
