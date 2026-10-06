import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { CiBindings } from "@cloudflare/ci/worker";
import type { Referee } from "./referee";

// The CI package owns ARTIFACTS, SANDBOX, BACKUP_BUCKET, CI_WORKFLOW, CF_TOKEN,
// CLOUDFLARE_ACCOUNT_ID and the R2 keys. Canon adds the referee, promotion and refresh.
export type Env = CiBindings & {
  REFEREE: DurableObjectNamespace<Referee>;
  PROMOTE_WORKFLOW: Workflow<CiParams<CloudflareArtifacts>>;
  REFRESH_WORKFLOW: Workflow<CiParams<CloudflareArtifacts>>;
  ASSETS: Fetcher;
  SOURCE: Artifacts; // namespace canon-src: Canon's own source
  SOURCE_PUBLIC: string; // "true" publishes canon.git and /src (flip on submission day)
  ARTIFACTS_NAMESPACE: string;
  // Part of each referee's name; bump it to reset every project's board.
  REFEREE_EPOCH: string;
  // Preview origin for an attempt, e.g. "https://{name}-farmstand.<subdomain>.workers.dev".
  // Used when `wrangler preview --json` output cannot be parsed.
  PREVIEW_URL_TEMPLATE: string;
  PRODUCTION_URL: string; // https://{project}.<subdomain>.workers.dev: each project deploys under its own Worker name
  // Secrets. Reads are public; every write needs one of these as a bearer key. The owner's key can do
  // anything; an agent's key can only claim, so accepting a fact stays a person's decision.
  CANON_KEY?: string;
  CANON_AGENT_KEY?: string;
};
