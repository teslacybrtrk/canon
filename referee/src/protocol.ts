import type { Diagnosis } from "./diagnosis";
import type { Review } from "./review";
import type { DataChanges, Evidence, Recovery } from "./evidence";
// The Canon protocol: four moves, one referee per project.
//
//   1. read     GET  /p/:project/canon               -> CanonState
//   2. declare  POST /p/:project/claims               -> Declared   (forks an attempt, mints a token)
//   3. push     git push <attempt remote> main           (plain Git; the referee hears the push event)
//   4. verdict  GET  /p/:project/attempts/:id/verdict   -> Verdict
//
// A fact is a sentence plus a check that can fail a preview. The facts live in the
// repo as canon.json, so they survive anywhere the Git repo goes. The referee only
// decides which attempt they currently point at, and it judges every attempt with the
// canon copy: an attempt may add the fact it claimed to its canon.json, nothing else.

export type FactStatus = "canon" | "proposed" | "retired" | "declined";
// seed: from genesis canon.json · agent: proposed in a claim · backlog: written by people in canon.json for agents to build
// "heldout": written by the owner straight into the judge, never in canon.json: agents see its sentence, never its check.
export type FactOrigin = "seed" | "agent" | "backlog" | "heldout";

export type ClaimStatus =
  | "open" //        declared, nothing pushed yet
  | "checking" //    pushed; preview building or checks running
  | "contradicts" // a canon fact broke on this attempt (rejected without reading the diff)
  | "unproven" //    canon held, but the claimed fact does not hold yet
  | "ready" //       canon held and the claimed fact holds; waiting on a human
  | "behind" //      canon gained a fact after this attempt forked; the judge re-applies it on the current canon
  | "accepted" //    a human accepted the fact; this attempt is canon
  | "superseded" // another attempt made the same fact true first
  | "declined" //   a person declined it (the reason is kept)
  | "error"; //      could not be judged: a platform error, not the code (push again)

export interface Fact {
  id: string; // slug, e.g. "price-is-listed"
  sentence: string;
  check: Check;
  scope: string[] | null; // globs; the fact is judged only on attempts that change a matching file. null = always
  replaces: string | null; // a revision: the canon fact this one retires when accepted
  origin: FactOrigin;
  status: FactStatus;
  proposedBy: string | null; // claim id
  madeTrueBy: string | null; // attempt id
  createdAt: number;
  acceptedAt: number | null;
  retiredBy: string | null; // attempt that retired it (by accepting a revision)
  acceptedHow: string | null; // who decided it: "the owner" (a person or an owner agent), or the rule that landed it on its own
  declinedAt: number | null; // a person declined the claim that proposed it, and nobody else was working on it
  heldOut?: boolean; // its check is hidden from agents (and from the public board); only the owner sees it
  declineReason: string | null;
  retiredAt: number | null;
}

/** How a fact is written in canon.json and in claims. */
export interface FactDef {
  id: string;
  sentence: string;
  check: Check;
  scope?: string[];
  replaces?: string;
}

/** canon.json at the root of every attempt. */
export interface CanonFile {
  version: 1;
  facts: FactDef[];
  // Facts people want made true. Agents claim them; with autoAccept "backlog" they land on their own.
  backlog?: FactDef[];
  policy?: Policy;
  production?: string; // where production answers (https://...), when it isn't the deployment's {project} template
}

// Who decides when no person clicks. off: a person accepts everything. backlog: an attempt on a fact people wrote lands
// on its own. charter: agent-proposed facts and rule changes land too, by rules people wrote once (see Charter).
export type AutoAccept = "off" | "backlog" | "charter";
export interface Charter {
  locked?: string[]; // canon facts no automatic decision may retire: only a person changes them
  priority?: string[]; // when two Ready facts clash, the one listed first wins (unlisted: the earlier-proposed fact)
  // Checks that are checked: the share of deliberate breaks (mutants) of an attempt's change its facts must catch
  // before autopilot lands it, from 0 to 1. Unset: the score is shown but never blocks.
  mutation?: number;
  // File globs no automatic decision may land: an attempt that changes one (auth, migrations, deploy config...) waits
  // for the owner, a person or an owner agent, however good its verdict. Facts settle behaviour; these get a reviewer.
  review?: string[];
  // true: a change the advisory reviewer flags with a "risk" note waits for the owner instead of landing on its own
  // (the reviewer still decides nothing: it can only make autopilot wait). Autopilot waits for the review to finish.
  reviewRisk?: boolean;
  // true: a reviewer "intent" note (the change does something its fact doesn't ask for) waits for the owner too, the
  // same as a risk: accountability between what a change claims to do and what it does.
  intentRisk?: boolean;
  // true: every claim must declare the files it will change (touches); a change outside them waits for the owner.
  requireScope?: boolean;
}
export interface Policy {
  autoAccept?: AutoAccept;
  // Merge trains: when several Ready claims may land at once (typically the queue behind a release), the judge
  // combines them into one candidate, verifies it once and releases it once. A train that fails lands them one by one.
  batch?: boolean;
  charter?: Charter;
  // The gradual rollout for a Worker without Durable Objects, after its 0% smoke test: the share of real traffic at each
  // step and how long each is watched. Default {"steps": [10, 50], "holdSeconds": 45}; false releases at 100% at once.
  canary?: { steps?: number[]; holdSeconds?: number } | false;
  // "none": the owner declares the app keeps no persistent state anywhere: no Cloudflare storage, and no external
  // database or service it writes to over HTTP. Only then, and only if its Wrangler config has no storage bindings
  // either, can a rollback rehearsal pass with nothing to compare. Without it, statefulness is unknown.
  state?: "none";
}

// ---- Checks -------------------------------------------------------------------
// One small deterministic evaluator: a sequence of HTTP requests against a
// preview, with assertions. Every run sends a fresh `x-canon-run` header; the
// app under test scopes its state to it, so runs never see each other's data.

export type Check = ProbeCheck | CommandCheck;

export interface ProbeCheck {
  kind: "probe";
  steps: ProbeStep[];
  // Random inputs, drawn again for every sample: {"qty": {"int": [1, 20]}, "item": {"oneOf": [...]}}.
  // Steps use them as {{qty}} or {{item.id}}, and expectations can add and multiply: "{{qty * item.cents}}".
  // The draws are seeded by the commit, the fact and a seed the judge picks after the push (recorded in the verdict).
  vars?: Record<string, VarSpec>;
  samples?: number; // run the steps this many times (1-10), each with fresh inputs and a fresh run
  // false: send the requests exactly as a visitor would, without the x-canon-run header, so the app
  // cannot tell the referee from real traffic. Only for facts that need no state of their own.
  isolate?: boolean;
  // The rollback rehearsal reads back what a fact wrote with its GET steps (see PROTOCOL.md, fixture contract). "none":
  // its owner declares the fact leaves no state a later read depends on, so there is nothing to compare across versions.
  fixture?: "none";
}

export type VarSpec = { int: [number, number] } | { oneOf: unknown[] };

// Runs in the CI container on the attempt's checkout: lint, types, tests, coverage, bundle size...
// The command is owned by canon, so an attempt cannot change what judges it.
export interface CommandCheck {
  kind: "command";
  run: string;
}

export interface ProbeStep {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // relative to the preview origin; may use {{var}}
  body?: unknown; // JSON; string leaves may use {{var}} (a leaf that is only "{{var}}" keeps the value's type)
  repeat?: number; // send the request this many times (after one warm-up) to measure latency
  // Send this many copies at the same moment (2-20), for facts about races: double-booking, overselling, duplicate
  // submits. Each copy may use {{i}} (0, 1, 2...) to differ. With statusCounts, the answers must add up exactly.
  concurrent?: number;
  expect?: {
    p95Ms?: number; // latency budget across the repeats
    status?: number | number[];
    // For a concurrent step: how many copies must get each status, e.g. {"201": 1, "409": 4}: exactly one booking wins.
    statusCounts?: Record<string, number>;
    // dot-path -> expected value. Paths support array indices and `.length`.
    // A value of {"$exists": true|false} asserts presence only.
    json?: Record<string, unknown>;
    bodyIncludes?: string;
  };
  save?: Record<string, string>; // var -> dot-path in the JSON response
}

export interface CheckResult {
  held: boolean;
  detail: string; // first failing assertion, or "ok"
  ms: number;
}

// ---- Claims and attempts -----------------------------------------------------------

export interface Claim {
  id: string;
  agent: string;
  factId: string;
  why: string; // the agent's own reason, kept in the fact chain
  attemptId: string;
  status: ClaimStatus;
  createdAt: number;
  refreshedFrom: string | null; // the behind claim the judge re-applied on the current canon as this one
  // How the judge's own refresh of this claim went, when it was behind: started, or why the agent must refresh it.
  refresh: string | null;
  declineReason: string | null; // why a person declined it
  autoWait: string | null; // under autopilot: why this Ready claim isn't landing on its own
  touches?: string[]; // the files it said it would change (DeclareRequest.touches)
  after?: string[]; // facts it builds on (DeclareRequest.after)
}

// Two Ready claims that can't both land. `factId` failed on the other attempt's preview at a later step than on the
// canon that attempt forked from: the other attempt changed the very behaviour the fact tests, the other way.
export interface Clash {
  with: { claimId: string; agent: string; attemptId: string; factId: string };
  factId: string; // the fact that breaks
  breaks: "mine" | "theirs"; // whose fact breaks on whose attempt
  detail: string;
}

export interface Attempt {
  id: string; // also the Artifacts repo name and the Preview name
  claimId: string | null; // null for genesis
  remote: string;
  baseAttempt: string | null; // the canon attempt this was forked from
  baseSha: string | null; // the canon commit it was forked from
  headSha: string | null;
  previewUrl: string | null;
  frozen: boolean; // canon attempts have their write tokens revoked
  createdAt: number;
}

// ---- Move 1: read ---------------------------------------------------------------

// A deliberate break of an attempt's own change, built as a preview and run against the facts.
export interface Mutant {
  file: string;
  line: number;
  op: string; // what was broken, e.g. "removed the guard", "409 → 200", "=== → !=="
  before: string;
  after: string;
  caught: boolean | null; // a fact failed on it; null: it didn't build or couldn't be checked
  by?: string; // the fact that caught it
}
export interface Mutation {
  status: "running" | "done" | "none";
  // Why there are no mutants: nothing to break ("no-source", "no-mutants": not applicable) or the platform failed
  // ("build-failed", "start-failed": unavailable, never a pass). See evidence.ts.
  reason?: "no-source" | "no-mutants" | "build-failed" | "start-failed";
  startedAt?: number; // when the run began (at is when it finished)
  total: number; // mutants that built and were checked
  caught: number;
  mutants: Mutant[];
  at: number;
}

export interface CanonState {
  project: string;
  canon: { attemptId: string; sha: string; seq: number; previewUrl: string | null; acceptance?: boolean } | null; // acceptance: it has a record
  facts: Fact[]; // canon + proposed
  claims: Array<Claim & { sentence: string; verdict: Verdict | null; clashes: Clash[]; headsUp?: Clash[]; mutation?: Mutation | null; reviewer?: Review | null }>;
  policy: { autoAccept: AutoAccept; charter: Charter | null };
  // The last time every canon probe fact ran against production (hourly, and after each deploy).
  production: { at: number; url: string; results: Record<string, { held: boolean; detail: string }> } | null;
  // Accepted, deployed and healthy are three different things. Each accepted canon is uploaded as a Worker version,
  // staged at 0% and smoke-tested on the production URL before any visitor gets it: a version that breaks a fact is
  // held back (production never served it). The first check after the release is a second net: broken, it rolls back.
  trains: Array<{ id: string; status: "building" | "judging" | "waiting" | "landed" | "failed"; detail: string | null; createdAt: number; baseSeq?: number | null; speculative?: boolean; half?: boolean; claims: Array<{ claimId: string; agent: string; factId: string }> }>;
  deploys: Array<{ seq: number; reverts?: number | null; facts?: string[]; factId: string | null; deployed: "pending" | "deployed" | "failed"; versionId: string | null; health: "healthy" | "held" | "broken" | "rolled-back" | null; detail: string | null }>;
}

// ---- Move 2: declare --------------------------------------------------------------

export type DeclareRequest = {
  agent: string;
  why: string;
  replaces?: string; // an earlier claim on the same fact that this one supersedes (canon refresh)
  // The files this attempt will change, as globs ("src/index.ts", "src/cart/**"). Declared, the claim is held to it:
  // a change outside it is an unclaimed edit, and autopilot leaves it to the owner. Passing a fact doesn't excuse it.
  touches?: string[];
  // Facts this attempt builds on ("after": ["no-double-booking"]): it isn't landed until they are canon, and it is
  // scheduled after them, instead of the dependency surfacing later as a clash or a failed verdict.
  after?: string[];
} & (
  | { fact: FactDef } // propose a new fact (with `replaces`: a revision of a canon fact)
  | { join: string } // race for a fact someone else already proposed
);

export interface Declared {
  claim: Claim;
  attempt: {
    id: string;
    remote: string; // https Git remote of the fork
    token: string; // write token scoped to this fork only
    expiresAt: string;
    branch: "main";
  };
}

// ---- Move 4: verdict -------------------------------------------------------------

export type Outcome = "pending" | "contradicts" | "unproven" | "behind" | "ready" | "error";

export interface Ledger {
  // ok: canon.json is canon plus this attempt's claimed fact, unchanged.
  // behind: it lacks facts accepted after the attempt was forked.
  // tampered: it changes, drops or invents a fact. The attempt is rejected.
  status: "ok" | "behind" | "tampered";
  detail: string;
}

export interface Verdict {
  attemptId: string;
  sha: string;
  previewUrl: string;
  canonSeq: number; // the canon this verdict was judged against
  outcome: Outcome;
  kept: string[]; // canon facts that held
  lost: Array<{ factId: string; detail: string }>; // facts canon at the fork that broke: a contradiction
  retires: string[]; // canon facts this attempt deliberately replaces (a revision): allowed to break
  skipped: string[]; // scoped facts not judged: this attempt changes none of their files
  // Facts accepted after the fork that fail: refresh needed. `clash`: the attempt built that behaviour the other way, so
  // the judge re-applies it on the new canon and rejects it only if the combined code still breaks the fact.
  stale: Array<{ factId: string; detail: string; clash?: boolean }>;
  claimed: { factId: string; held: boolean; detail: string };
  offers: string[]; // other proposed facts this attempt happens to make true
  ledger: Ledger; // the attempt's canon.json against canon
  judgedAt: number;
  // The judge's own random draw for this verdict, picked after the commit was pushed: probe inputs come from the
  // commit, this seed and the fact, so no agent can know them in advance, and the verdict can be replayed exactly.
  seed?: string;
  // Files this attempt changed that the charter routes to review (see Charter.review).
  review?: string[];
  // Schema changes in the lines it adds: destructive ones (DROP, RENAME, deleted Durable Object classes) wait for the
  // owner, since rolling a Worker back doesn't roll its data back. See evidence.ts.
  data?: DataChanges;
  // Files it changed outside the scope its claim declared (`touches`); absent when it declared none.
  outside?: string[];
  // Accepted, then held back at release (or rolled back): the canon reverted, and this says what broke where.
  heldBack?: string;
  // Added when the verdict is read (GET /attempts/:id/verdict), not stored with it:
  refreshedAs?: string; // canon moved, and the judge re-applied this attempt on the current canon as this attempt
  declined?: string; // a person declined this claim, for this reason
  clashes?: Clash[];
  // The same comparison while at least one side is still being written (unproven): a warning to both agents before
  // either is Ready, so they can talk it over (or one can change course) instead of finding out at accept time.
  headsUp?: Clash[];
  reviewer?: Review | null; // the advisory reviewer's grounded notes (a model that didn't write the change), never a verdict
  diagnosis?: Diagnosis | null; // what kind of failure this is, and what would resolve it (see diagnosis.ts)
}

/**
 * The acceptance record: what exactly was authorized to become canon and be released, on what evidence, under which
 * policy. Written once, when canon moves; the release Workflow deploys only the commit it names, and only while it is
 * still the latest canon (a stale candidate is refused). GET /p/:project/canon/:seq/acceptance, and in the Git note.
 */
export interface Acceptance {
  canonSeq: number;
  sha: string; // the one commit authorized for release
  attemptId: string; // the attempt (or merge train) that holds it
  judgedOnCanon: number; // the canon its verdict was judged against: the one it lands on
  facts: Array<{
    id: string;
    sentence: string;
    check: string; // a version of the fact's check definition (policyVersion of its JSON)
    madeTrueBy: { attemptId: string; sha: string; seed?: string; previewUrl?: string };
    evidence: { mutation: Evidence; review: Evidence; data: Evidence; scope: Evidence };
  }>;
  verdict: { kept: number; skipped: number; seed?: string; previewUrl: string; judgedAt: number };
  environment: string; // where the checks ran
  authorizedBy: string; // "the owner", or the autopilot/charter reasons
  chosenBecause?: string; // the reason given for choosing this attempt (a person's own words, or the rule that chose it)
  exceptions: string[]; // required evidence that failed or was unavailable, which a person accepted anyway
  // The other attempts at the same facts, and what became of them (declined with a reason, broke a fact, superseded):
  // the alternatives this decision passed over.
  alternatives?: Array<{ factId: string; attemptId: string; agent: string; outcome: string }>;
  policy: { autoAccept: string; charter: Charter; version: string };
  recovery: Recovery; // how a failed release recovers, and the rollback rehearsal's result once the release ran it
  // The gradual rollout, step by step: the share of traffic, what was watched (synthetic checks on both versions at the
  // same moment, routed checks, and real traffic per version when analytics allow), and the verdict.
  exposure?: Array<{ percent: number; newFails: number; oldFails: number; routedFails: number; mixedFails?: number; checks: number; raw: string; analytics: string; verdict: string; at: number }>;
  at: number;
}

// Errors lose their class crossing the Durable Object RPC boundary, so the HTTP
// status travels in the message as a "[409] " prefix.
export class ProtocolError extends Error {
  constructor(status: number, message: string) {
    super(`[${status}] ${message}`);
  }
}

export function errorStatus(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/^\[(\d{3})\] (.*)$/s);
  return m ? { status: Number(m[1]), message: m[2] } : { status: 500, message: raw };
}
