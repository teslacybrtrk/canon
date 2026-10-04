import { CIWorkflow, isCiRunnerFailure, type CiContext, type CiParams, type CiRunnerResult, type CloudflareArtifacts } from "@cloudflare/ci";
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
    try {
      const deps = await ci.runner({
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
    await step.do("record promotion", () => refereeForRepo(this.env, repo).promoted(seq, ok));
  }
}

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
