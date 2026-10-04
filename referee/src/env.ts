import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { CiBindings } from "@cloudflare/ci/worker";
import type { Referee } from "./referee";

// The CI package owns ARTIFACTS, SANDBOX, BACKUP_BUCKET, CI_WORKFLOW, CF_TOKEN,
// CLOUDFLARE_ACCOUNT_ID and the R2 keys. Canon adds the referee and promotion.
export type Env = CiBindings & {
  REFEREE: DurableObjectNamespace<Referee>;
  PROMOTE_WORKFLOW: Workflow<CiParams<CloudflareArtifacts>>;
  ASSETS: Fetcher;
  ARTIFACTS_NAMESPACE: string;
  // Part of each referee's name; bump it to reset every project's board.
  REFEREE_EPOCH: string;
  // Preview origin for a world, e.g. "https://{name}-farmstand.<subdomain>.workers.dev".
  // Used when `wrangler preview --json` output cannot be parsed.
  PREVIEW_URL_TEMPLATE: string;
  PRODUCTION_URL: string;
};
