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

export type FactStatus = "canon" | "proposed" | "retired";
// seed: from genesis canon.json · agent: proposed in a claim · backlog: written by people in canon.json for agents to build
export type FactOrigin = "seed" | "agent" | "backlog";

export type ClaimStatus =
  | "open" //        declared, nothing pushed yet
  | "checking" //    pushed; preview building or checks running
  | "contradicts" // a canon fact broke on this attempt (rejected without reading the diff)
  | "unproven" //    canon held, but the claimed fact does not hold yet
  | "ready" //       canon held and the claimed fact holds; waiting on a human
  | "behind" //      canon gained a fact after this attempt forked; `canon refresh` onto the current canon
  | "accepted" //    a human accepted the fact; this attempt is canon
  | "superseded" // another attempt made the same fact true first
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
  policy?: { autoAccept?: "off" | "backlog" };
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
  // The draws are seeded by the commit and the fact: unknown before the push, the same every time it is judged.
  vars?: Record<string, VarSpec>;
  samples?: number; // run the steps this many times (1-10), each with fresh inputs and a fresh run
  // false: send the requests exactly as a visitor would, without the x-canon-run header, so the app
  // cannot tell the referee from real traffic. Only for facts that need no state of their own.
  isolate?: boolean;
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
  expect?: {
    p95Ms?: number; // latency budget across the repeats
    status?: number | number[];
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

export interface CanonState {
  project: string;
  canon: { attemptId: string; sha: string; seq: number; previewUrl: string | null } | null;
  facts: Fact[]; // canon + proposed
  claims: Array<Claim & { sentence: string; verdict: Verdict | null }>;
  policy: { autoAccept: "off" | "backlog" };
  // The last time every canon probe fact ran against production (hourly, and after each deploy).
  production: { at: number; url: string; results: Record<string, { held: boolean; detail: string }> } | null;
}

// ---- Move 2: declare --------------------------------------------------------------

export type DeclareRequest = {
  agent: string;
  why: string;
  replaces?: string; // an earlier claim on the same fact that this one supersedes (canon refresh)
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
  stale: Array<{ factId: string; detail: string }>; // facts accepted after the fork that fail: refresh needed
  claimed: { factId: string; held: boolean; detail: string };
  offers: string[]; // other proposed facts this attempt happens to make true
  ledger: Ledger; // the attempt's canon.json against canon
  judgedAt: number;
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
