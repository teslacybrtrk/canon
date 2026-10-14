import { DurableObject } from "cloudflare:workers";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { Env } from "./env";
import type { Novelty } from "./commands";
import { compareLedger } from "./ledger";
import { assertionOf, diagnose } from "./diagnosis";
import { compareFixtures, fixtureContract, progress, runCheck, templateNames, writeFixture, type Fixture } from "./probe";
import {
  ProtocolError,
  errorStatus,
  type CanonFile,
  type CanonState,
  type Check,
  type CheckResult,
  type Clash,
  type Claim,
  type ClaimStatus,
  type DeclareRequest,
  type Declared,
  type Fact,
  type FactDef,
  type FactOrigin,
  type Ledger,
  type Verdict,
  type Attempt,
  type AutoAccept,
  type Charter,
  type ProbeCheck,
  type Mutant,
  type Mutation,
  type Acceptance,
} from "./protocol";
import { edgeFailure, platformFailure } from "./platform";
import { addedText, callsInto, changedSymbols } from "./symbols";
import { fileFromAnswer, parseConflicts, repairPrompt, validResolution } from "./repair";
import { SCHEMA, UPGRADES } from "./schema";
import { deploymentOwner, holdsLease, JUDGE_WRITE_MS, leaseDecision, RELEASE_LEASE_MS, RELEASE_START_MS, writeBarrier, type Lease } from "./release";
import { ACCOUNT_SLOTS, BACKGROUND_SLOTS } from "./slots";
import { canaryVerdict, versionTraffic } from "./telemetry";
import { compatibilityVerdict, dataChanges, dataEvidence, dataFiles, gate, mutationEvidence, policyVersion, recoveryFor, reviewEvidence, statelessBasis, storageBindings, type CompatibilityCoverage, type DataChanges, type Evidence } from "./evidence";
import { changedLines, judgeAnswer, rankNotes, REVIEW_SCHEMA, reviewBatches, reviewPrompt, specialistsFor, type Review, type ReviewFile, type ReviewNote, type Specialist, type UnresolvedNote } from "./review";

// The advisory reviewer: a different model from the agents' (they are Claude or Grok), on Workers AI.
const REVIEW_MODELS = ["@cf/moonshotai/kimi-k2.7-code", "@cf/moonshotai/kimi-k2.6"];
import { diffTrees, inScope } from "./scope";
import { ownerPath, publishTarget, type PublishTarget } from "./publish";

const ATTEMPT_TOKEN_TTL_S = 4 * 60 * 60;
const PREVIEW_READY_TIMEOUT_MS = 45_000;
const LIVE: ClaimStatus[] = ["checking", "contradicts", "unproven", "behind", "ready", "error"];

type Row = Record<string, SqlStorageValue>;

const LIVE_CHECK_TTL_MS = 30_000;
// How long the first claim that may land waits for others to board the same merge train.
const BOARDING_MS = 60_000;
// Canon accepted before this moment has no acceptance record (they were added then); anything later must have one.
const ACCEPTANCE_RECORDS_SINCE = Date.parse("2026-10-13T00:00:00Z");
const HELD_OUT_DETAIL = "a held-out fact broke (the owner keeps its check out of the repo; it can't be shown)";
const VERIFY_SLOTS = 6;
const DATA_MAX_FILES = 60; // changed files the data inspection reads; more makes it incomplete (unavailable)
const REVIEW_MAX_FILES = 12; // a change touching more source files than this is too big to review (split into passes up to here): unavailable
const REVIEW_STUCK_MS = 10 * 60_000; // a review still running after this never finished (evidence.ts agrees) // commits a project verifies at once; the rest queue (see admit)
const SPECULATIVE_BOARDING_MS = 3_000; // boarding while a release runs: the riders leave as a speculative train
const PRODUCTION_CHECK_EVERY_MS = 60 * 60_000;
// The forked-from files travel to CI inside the command line; past this size the novelty check is skipped.
const NOVELTY_MAX_B64 = 48_000;

/** One referee per project. The only writer of facts, claims and the canon pointer. */
export class Referee extends DurableObject<Env> {
  private sql: SqlStorage;
  private caughtUpAt = new Map<string, number>(); // attempt id -> last head check (see catchUp)
  private changedCache = new Map<string, string[] | null>();
  private liveChecks = new Map<string, CheckResult & { url: string; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    for (const upgrade of UPGRADES) {
      try {
        this.sql.exec(upgrade);
      } catch {
        // column already exists
      }
    }
  }

  // ---- Setup ---------------------------------------------------------------------

  /**
   * Creates the genesis attempt. Either push a repo containing canon.json to the returned
   * remote, or pass `importUrl` to start from an existing Git repo (e.g. on GitHub).
   * Genesis becomes canon once its preview satisfies every fact in its own canon.json.
   */
  async genesis(project: string, importUrl?: string) {
    if (!/^[a-z0-9]{2,20}$/.test(project)) throw new ProtocolError(400, "project must be 2-20 chars of [a-z0-9]");
    if (this.meta("project")) throw new ProtocolError(409, "genesis already ran");
    const id = `${project}-genesis`;
    const created = importUrl
      ? await this.env.ARTIFACTS.import({ source: { url: importUrl }, target: { name: id, opts: { description: `Canon genesis for ${project}` } } })
      : await this.env.ARTIFACTS.create(id, { description: `Canon genesis for ${project}` });
    this.setMeta("project", project);
    this.sql.exec(`INSERT INTO attempts (id, claim_id, remote, created_at) VALUES (?, NULL, ?, ?)`, id, created.remote, Date.now());
    if (importUrl) {
      // An import emits no push event, so start the same verify pipeline directly.
      using repo = await this.env.ARTIFACTS.get(id);
      const [head] = await repo.log({ limit: 1 });
      if (head) {
        this.sql.exec(`UPDATE attempts SET head_sha = ? WHERE id = ?`, head.hash, id);
        // The epoch is in the id: after a reset, importing the same repo again must start a new instance.
        await this.env.CI_WORKFLOW.create({ id: `genesis-${this.env.REFEREE_EPOCH}-${head.hash.slice(0, 12)}`, params: this.ciParams(id, head.hash) });
      }
    }
    this.broadcast();
    return { attemptId: id, remote: created.remote, token: created.token };
  }

  // ---- Held-out facts ---------------------------------------------------------------
  //
  // Facts the owner keeps out of the repo: written straight into the judge, enforced on every verdict, release and
  // mutation run like any canon fact, but agents (and the public board) see only the sentence: never the check, never
  // the details of a failure. An agent can't tune its code to a check it can't read, and can't edit one it can't see.

  private heldOutIds(): Set<string> {
    return new Set(this.rows(`SELECT id FROM facts WHERE origin = 'heldout'`).map((r) => r.id as string));
  }

  private redactFact(f: Fact): Fact {
    return f.origin === "heldout" ? { ...f, check: { kind: "probe", steps: [] }, heldOut: true } : f;
  }

  private redactVerdict<V extends Verdict | null>(v: V, hidden: Set<string>): V {
    if (!v || !hidden.size) return v;
    const hide = (id: string, detail: string) => (hidden.has(id) ? HELD_OUT_DETAIL : detail);
    return { ...v, lost: v.lost.map((l) => ({ ...l, detail: hide(l.factId, l.detail) })), stale: v.stale.map((x) => ({ ...x, detail: hide(x.factId, x.detail) })) };
  }

  private redactProduction(p: { at: number; url: string; results: Record<string, CheckResult> } | null, hidden: Set<string>) {
    if (!p?.results || !hidden.size) return p;
    return { ...p, results: Object.fromEntries(Object.entries(p.results).map(([id, r]) => [id, hidden.has(id) ? { ...r, detail: r.held ? "ok" : HELD_OUT_DETAIL } : r])) };
  }

  /**
   * The owner adds a held-out fact. Like a seed fact it must already hold: a probe is checked on canon's own preview
   * before it's stored (a command fact is checked on the next verdict, in CI). Owner only; never written to canon.json.
   */
  async addHeldOut(def: FactDef) {
    if (!def?.id || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(def.id) || typeof def.sentence !== "string" || !def.sentence.trim()) throw new ProtocolError(400, 'a held-out fact needs {"id": "slug", "sentence": "...", "check": {...}}');
    validateCheck(def.check);
    if (this.fact(def.id)) throw new ProtocolError(409, `fact "${def.id}" exists`);
    const canon = this.currentCanon();
    const preview = canon ? this.attempt(canon.attempt_id as string)?.previewUrl : null;
    if (def.check.kind === "probe") {
      if (!preview) throw new ProtocolError(409, "canon has no preview to check it on yet");
      const r = await runCheck(def.check as ProbeCheck, preview, `heldout:${def.id}`);
      if (!r.held) throw new ProtocolError(409, `it doesn't hold on canon now: ${r.detail}`);
    }
    const now = Date.now();
    this.insertFact(def, "canon", "heldout", now, now);
    this.sql.exec(`UPDATE facts SET accepted_how = 'the owner, held out' WHERE id = ?`, def.id);
    this.broadcast();
    return { id: def.id, heldOut: true };
  }

  /** The held-out facts in full: owner only. */
  heldOut(): Fact[] {
    return this.rows(`SELECT * FROM facts WHERE origin = 'heldout' ORDER BY created_at`).map(toFact);
  }

  // ---- Move 1: read ----------------------------------------------------------------

  read(): CanonState {
    const canon = this.currentCanon();
    const hidden = this.heldOutIds();
    const facts = this.rows(`SELECT * FROM facts ORDER BY status, created_at`).map(toFact).map((f) => this.redactFact(f));
    const sentences = new Map(facts.map((f) => [f.id, f.sentence]));
    const claims = this.rows(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 200`).map((r) => {
      const claim = toClaim(r);
      const verdict = this.latestVerdict(claim.attemptId);
      const m = verdict ? this.rows(`SELECT json FROM mutations WHERE attempt_id = ? AND sha = ?`, claim.attemptId, verdict.sha)[0] : null;
      const shown = this.redactVerdict(verdict, hidden);
      return { ...claim, sentence: sentences.get(claim.factId) ?? claim.factId, verdict: shown ? { ...shown, diagnosis: this.diagnosisOf(claim, shown) } : shown, clashes: this.clashesFor(claim.id), headsUp: this.headsUpFor(claim.id), mutation: m ? (JSON.parse(m.json as string) as Mutation) : null, reviewer: verdict ? this.reviewOf(claim.attemptId, verdict.sha) : null };
    });
    return {
      project: this.meta("project") ?? "",
      canon: canon && { attemptId: canon.attempt_id as string, sha: canon.sha as string, seq: canon.seq as number, previewUrl: this.attempt(canon.attempt_id as string)?.previewUrl ?? null, acceptance: this.rows(`SELECT 1 FROM acceptances WHERE seq = ?`, canon.seq).length > 0 },
      facts,
      claims,
      policy: { autoAccept: this.autoAccept(), charter: this.charter() },
      production: this.redactProduction(JSON.parse(this.meta("production") ?? "null"), hidden),
      trains: this.rows(`SELECT * FROM trains ORDER BY created_at DESC LIMIT 5`).map((t) => ({
        id: t.id as string,
        status: t.status as "building" | "judging" | "waiting" | "landed" | "failed",
        detail: (t.detail as string | null) ?? null,
        baseSeq: (t.base_seq as number | null) ?? null,
        speculative: t.speculative === 1,
        half: t.half === 1,
        createdAt: t.created_at as number,
        claims: (JSON.parse(t.claims as string) as string[]).flatMap((id) => {
          const c = this.claim(id);
          return c ? [{ claimId: c.id, agent: c.agent, factId: c.factId }] : [];
        }),
      })),
      deploys: this.rows(`SELECT * FROM canon ORDER BY seq DESC LIMIT 10`).map((r) => ({
        seq: r.seq as number,
        reverts: (r.reverts as number | null) ?? null,
        facts: r.facts_json ? (JSON.parse(r.facts_json as string) as string[]) : r.accepted_fact ? [r.accepted_fact as string] : [],
        factId: (r.accepted_fact as string | null) ?? null,
        deployed: r.deployed === 1 ? "deployed" : r.deployed === -1 ? "failed" : "pending",
        versionId: (r.version_id as string | null) ?? null,
        health: (r.health as "healthy" | "held" | "broken" | "rolled-back" | null) ?? null,
        detail: (r.health_detail as string | null) ?? null,
      })),
    };
  }

  /**
   * The feature ledger: every fact someone asked for, from the request to production, built only from the judge's own
   * records (facts, claims, verdicts, canon, acceptance records, the last production check). Stages stay apart:
   * requested, in progress, verified (Ready), waiting for evidence or a person, accepted, released, healthy in
   * production, held back, declined, retired. Held-out checks stay hidden, as on the board.
   */
  ledger() {
    const state = this.read();
    const project = state.project;
    const rows = this.rows(`SELECT * FROM canon ORDER BY seq`);
    const landedIn = new Map<string, Row[]>();
    for (const r of rows) {
      const ids = r.facts_json ? (JSON.parse(r.facts_json as string) as string[]) : r.accepted_fact ? [r.accepted_fact as string] : [];
      for (const id of ids) landedIn.set(id, [...(landedIn.get(id) ?? []), r]);
    }
    const reverted = new Set(rows.map((r) => r.reverts).filter((x) => x !== null && x !== undefined));
    const results = state.production?.results ?? {};
    const sentences = new Map(state.facts.map((f) => [f.id, f.sentence]));
    const sentence = (id: string) => sentences.get(id) ?? id;
    const now = Date.now();
    const features = this.rows(`SELECT * FROM facts ORDER BY created_at`).map(toFact).map((f) => this.redactFact(f)).map((f) => {
      const claims = state.claims.filter((c) => c.factId === f.id).sort((a, b) => a.createdAt - b.createdAt);
      const attempts = claims.map((c) => ({
        claimId: c.id, agent: c.agent, status: c.status, at: c.createdAt, why: c.why,
        attempt: c.attemptId, sha: c.verdict?.sha.slice(0, 12) ?? null, canonSeq: c.verdict?.canonSeq ?? null,
        judgedAt: c.verdict?.judgedAt ?? null, judge: c.verdict?.judge ?? null, preview: c.verdict?.previewUrl || null,
        failure: failureOf(c.verdict, sentence),
        reappliedFrom: c.refreshedFrom ? (state.claims.find((x) => x.id === c.refreshedFrom)?.attemptId ?? c.refreshedFrom) : null, after: c.after ?? [],
        mutationRun: c.mutation ?? null,
        outcome: c.verdict?.outcome ?? null,
        diagnosis: c.verdict?.diagnosis ? { kind: c.verdict.diagnosis.kind, why: c.verdict.diagnosis.why, next: c.verdict.diagnosis.next } : null,
        waiting: c.autoWait,
        mutation: c.mutation?.status === "done" ? `${c.mutation.caught}/${c.mutation.total} deliberate breaks caught` : null,
        review: c.reviewer?.status === "done" ? `${c.reviewer.notes.length} note${c.reviewer.notes.length === 1 ? "" : "s"}${c.reviewer.notes.some((n) => n.kind === "risk") ? ", including a risk" : ""}` : c.reviewer?.status ?? null,
      }));
      const releases = (landedIn.get(f.id) ?? []).map((r) => {
        const seq = r.seq as number;
        const rec = this.acceptance(seq);
        return {
          seq, sha: String(r.sha).slice(0, 12), at: Number(r.at), versionId: (r.version_id as string | null) ?? null,
          release: r.deployed === 1 ? "deployed" : r.deployed === -1 ? "not released" : "in progress",
          health: (r.health as string | null) ?? null, detail: (r.health_detail as string | null) ?? null, reverted: reverted.has(seq),
          authorizedBy: rec?.authorizedBy ?? null, exceptions: rec?.exceptions ?? [],
          rehearsal: rec?.recovery?.rehearsal ? `${rec.recovery.rehearsal.state}: ${rec.recovery.rehearsal.detail.slice(0, 200)}` : null,
          rollout: (rec?.exposure ?? []).map((e) => `${e.percent}%: ${e.verdict}`),
          record: rec ? `/p/${project}/canon/${seq}/acceptance` : null,
          checkVersion: rec?.facts.find((x) => x.id === f.id)?.check ?? null, policyVersion: rec?.policy.version ?? null, judge: rec?.judge ?? null,
          coverage: rec?.recovery.coverage ? { compared: rec.recovery.coverage.compared.length, incompatible: rec.recovery.coverage.incompatible.length, inconclusive: rec.recovery.coverage.inconclusive.length, unsupported: rec.recovery.coverage.unsupported.length, notApplicable: rec.recovery.coverage.notApplicable.length } : null,
          override: rec?.recovery.override ?? null,
        };
      });
      const last = releases.at(-1);
      const ready = attempts.filter((a) => a.status === "ready");
      const working = attempts.some((a) => ["open", "checking", "unproven", "behind"].includes(a.status));
      const check = f.heldOut ? "held out: the check is hidden from agents and the public" : f.check.kind === "probe" ? `${f.check.steps.length} HTTP step${f.check.steps.length === 1 ? "" : "s"} on a live preview${f.check.isolate === false ? ", sent as a visitor" : ""}` : `command: ${f.check.run.slice(0, 120)}`;
      const prod = results[f.id];
      let stage: string;
      let detail = "";
      if (f.status === "retired") (stage = "retired"), (detail = "replaced by a revision someone accepted");
      else if (f.origin === "seed") (stage = "baseline"), (detail = "true since genesis");
      else if (f.origin === "heldout" && f.status === "canon") (stage = "baseline"), (detail = "held out by the owner: enforced on every verdict and release since it was added");
      else if (f.status === "canon") {
        if (!last || last.release === "in progress") (stage = "accepted"), (detail = "accepted; its release is in progress");
        else if (last.health === "broken") (stage = "broken in production"), (detail = last.detail ?? "");
        else (stage = prod?.held ? "healthy in production" : "released"), (detail = `canon #${last.seq}${last.versionId ? `, Worker version ${last.versionId.slice(0, 8)}` : ""}`);
      } else if (f.declinedAt) (stage = "declined"), (detail = f.declineReason ?? "");
      else if (ready.length) {
        const waiting = ready.find((a) => a.waiting);
        if (waiting && ready.every((a) => a.waiting)) (stage = "waiting for a person or evidence"), (detail = waiting.waiting ?? "");
        else (stage = "verified"), (detail = "Ready: every fact holds on its preview; landing next");
      } else if (working) (stage = "in progress"), (detail = "being built or re-applied");
      else if (last && (last.release === "not released" || last.reverted)) (stage = "held back at release"), (detail = last.detail ?? "production never served it");
      else if (attempts.length) (stage = "attempts failed"), (detail = attempts.at(-1)?.diagnosis?.why ?? "");
      else (stage = "requested"), (detail = "no attempt yet");
      const needs = [
        ...ready.filter((a) => a.waiting).map((a) => `${a.agent}'s attempt: ${a.waiting}`),
        ...attempts.filter((a) => a.diagnosis && ["requirement", "unsupported-check"].includes(a.diagnosis.kind)).map((a) => `${a.diagnosis!.why}. Next: ${a.diagnosis!.next}`),
      ];
      // The evidence behind the stage, each item with its state and when it was observed: what passed, what's missing,
      // what's stale. "Partially verified" means the checks passed but some of this is missing or incomplete.
      const evidence: Array<{ what: string; state: "ok" | "gap" | "missing" | "stale" | "bad"; detail: string; at: number | null }> = [];
      const maker = f.madeTrueBy ? attempts.find((a) => a.attempt === f.madeTrueBy) : ready[0];
      if (maker?.judgedAt) {
        evidence.push({ what: "verified", state: "ok", detail: `${maker.agent}'s commit ${maker.sha?.slice(0, 7)} on its own preview, against canon #${maker.canonSeq}${maker.judge ? ` (judge version ${maker.judge.slice(0, 8)})` : ""}`, at: maker.judgedAt });
        if (f.status === "proposed" && state.canon && maker.canonSeq !== null && maker.canonSeq < state.canon.seq) evidence.push({ what: "stale", state: "stale", detail: `judged against canon #${maker.canonSeq}; canon is now #${state.canon.seq}, so it is re-applied and judged again before it can land`, at: maker.judgedAt });
        const m = maker.mutationRun;
        if (m?.status === "done" && m.total) evidence.push({ what: "deliberate breaks", state: m.caught === m.total ? "ok" : "gap", detail: m.caught === m.total ? `all ${m.total} deliberate breaks of the change were caught by a check` : `${m.total - m.caught} of ${m.total} deliberate breaks of the change went unnoticed by every check (code no check covers)`, at: m.at });
        else if (m?.status === "done" && (m.reason === "build-failed" || m.reason === "start-failed")) evidence.push({ what: "deliberate breaks", state: "missing", detail: "the mutation run couldn't build its breaks, so how well the checks cover the change is unknown", at: m.at });
      }
      if (last) {
        const r = last;
        if (r.rehearsal) evidence.push({ what: "rollback rehearsal", state: r.rehearsal.startsWith("passed") ? "ok" : r.rehearsal.startsWith("failed") ? "bad" : "missing", detail: r.rehearsal, at: null });
        if (r.coverage && (r.coverage.unsupported || r.coverage.inconclusive)) evidence.push({ what: "rollback coverage", state: "gap", detail: `compared ${r.coverage.compared} fact${r.coverage.compared === 1 ? "" : "s"} across versions; ${r.coverage.unsupported} couldn't be compared and ${r.coverage.inconclusive} were inconclusive`, at: null });
        if (r.override) evidence.push({ what: "owner exception", state: "gap", detail: r.override, at: null });
        if (r.exceptions.length) evidence.push({ what: "accepted over", state: "gap", detail: r.exceptions.join("; "), at: null });
      }
      if (f.status === "canon" && prod && state.production?.at) {
        const age = now - state.production.at;
        evidence.push({ what: "production", state: !prod.held ? "bad" : age > 24 * 3600_000 ? "stale" : "ok", detail: prod.held ? `holds on production${age > 24 * 3600_000 ? "; last observed over a day ago" : ""}` : "fails on production", at: state.production.at });
      } else if (f.status === "canon" && f.check.kind === "probe" && !f.heldOut && !prod) evidence.push({ what: "production", state: "missing", detail: "not observed on production yet", at: null });
      const partial = f.status !== "retired" && f.origin !== "seed" ? evidence.filter((e) => e.state === "gap" || e.state === "missing").map((e) => `${e.what}: ${e.detail}`) : [];
      return {
        id: f.id, sentence: f.sentence, check, status: f.status, stage, detail,
        requestedBy: f.origin === "backlog" ? "people (backlog)" : f.origin === "seed" ? "genesis" : f.origin === "heldout" ? "the owner (held out)" : `an agent (${claims[0]?.agent ?? "claim"})`,
        after: [...new Set(attempts.flatMap((a) => a.after))],
        attempts: attempts.map(({ mutationRun, ...a }) => a), releases,
        production: f.status === "canon" && prod ? { held: prod.held, at: state.production?.at ?? null } : null,
        needs, evidence, partial,
        madeTrueBy: f.madeTrueBy ?? null, replaces: f.replaces ?? null,
      };
    });
    const count = (stage: string) => features.filter((x) => x.stage === stage).length;
    return {
      project,
      canon: state.canon ? { seq: state.canon.seq, sha: state.canon.sha.slice(0, 12) } : null,
      production: state.production ? { at: state.production.at, url: state.production.url } : null,
      summary: {
        requested: features.filter((x) => x.stage !== "baseline").length,
        released: count("released") + count("healthy in production"),
        healthy: count("healthy in production"),
        inProgress: count("in progress") + count("verified") + count("accepted"),
        needsAPerson: features.filter((x) => x.needs.length).length,
        heldBack: new Set(features.flatMap((x) => x.releases.filter((r) => r.release === "not released" || r.reverted).map((r) => r.seq))).size, // releases held back: a merge train held as a whole counts once
        partiallyVerified: features.filter((x) => x.partial.length && x.stage !== "baseline").length,
      },
      features,
    };
  }

  /** Whether anyone may read this project (board, ledger, records, repository), or only holders of a key. */
  isPublic(): boolean {
    return this.meta("public") === "1";
  }

  /** The owner publishes the project, read-only, or takes it back. */
  setPublic(on: boolean) {
    this.setMeta("public", on ? "1" : "0");
    return { project: this.requireProject(), public: on };
  }

  /**
   * The run as it happened, oldest first, from the judge's own tables (claims, pushes, verdicts, clash warnings, merge
   * trains, canon moves, releases, declines), each event pointing at the record it comes from: for replaying a recorded
   * run step by step. Held-out details stay redacted.
   */
  timeline() {
    const project = this.requireProject();
    const hidden = this.heldOutIds();
    const facts = new Map(this.rows(`SELECT * FROM facts`).map(toFact).map((f) => [f.id, f]));
    const said = (id: string | undefined) => `“${(id && facts.get(id)?.sentence) ?? id ?? "a fact"}”`;
    const claims = this.rows(`SELECT * FROM claims ORDER BY created_at`).map(toClaim);
    const byAttempt = new Map(claims.map((c) => [c.attemptId, c]));
    const byId = new Map(claims.map((c) => [c.id, c]));
    type Event = { at: number; kind: string; tone: "good" | "bad" | "wait" | "note"; text: string; agent?: string; fact?: string; attempt?: string; sha?: string; link?: string; preview?: string; judge?: string };
    const out: Event[] = [];
    for (const c of claims) {
      const from = c.refreshedFrom ? byId.get(c.refreshedFrom) : null;
      out.push(c.refreshedFrom
        ? { at: c.createdAt, kind: "reapply", tone: "note", agent: c.agent, fact: c.factId, attempt: c.attemptId, text: `The judge re-applied ${c.agent}'s change for ${said(c.factId)} onto the newer canon${from ? `, from ${from.attemptId}` : ""}` }
        : { at: c.createdAt, kind: "claim", tone: "note", agent: c.agent, fact: c.factId, attempt: c.attemptId, text: `${c.agent} claimed ${said(c.factId)}: “${c.why}”` });
    }
    for (const p of this.rows(`SELECT * FROM pushes ORDER BY at`)) {
      const c = byAttempt.get(p.attempt_id as string);
      if (c) out.push({ at: p.at as number, kind: "push", tone: "note", agent: c.agent, fact: c.factId, attempt: c.attemptId, sha: String(p.sha).slice(0, 12), text: `${c.refreshedFrom ? "The judge" : c.agent} pushed ${String(p.sha).slice(0, 7)} with plain Git` });
    }
    for (const r of this.rows(`SELECT attempt_id, sha, json, at FROM verdicts ORDER BY at`)) {
      const c = byAttempt.get(r.attempt_id as string);
      const v = this.redactVerdict(JSON.parse(r.json as string) as Verdict, hidden);
      const d = c ? this.diagnosisOf(c, v) : null;
      const what = v.outcome === "ready" ? `Ready: every fact holds on the preview of ${v.sha.slice(0, 7)} (${v.kept.length} canon facts kept${c ? `, and ${said(c.factId)}` : ""})`
        : failureOf(v, (id) => facts.get(id)?.sentence ?? id) ?? v.outcome;
      // The diagnosis only where it adds something: an implementation failure already says what broke, and "behind" says
      // the judge re-applies it.
      const plain = { combination: "two changes that fail together", requirement: "the requirement itself", "unsupported-check": "a check that can't be made", infrastructure: "the platform, not the code" } as Record<string, string>;
      const why = d && v.outcome !== "behind" && plain[d.kind] ? `. The judge's diagnosis: ${plain[d.kind]}; next: ${d.next}` : "";
      out.push({ at: r.at as number, kind: "verdict", tone: v.outcome === "ready" ? "good" : v.outcome === "behind" || v.outcome === "pending" ? "wait" : "bad", agent: c?.agent, fact: c?.factId, attempt: r.attempt_id as string, sha: v.sha.slice(0, 12), ...(v.previewUrl ? { preview: v.previewUrl } : {}), ...(v.judge ? { judge: v.judge } : {}), link: `/p/${project}/attempts/${r.attempt_id}/verdict`, text: `${c ? `${c.agent}: ` : "Genesis: "}${what}${why}` });
    }
    for (const k of this.rows(`SELECT * FROM clashes ORDER BY at`)) {
      const a = byId.get(k.claim_id as string);
      const b = byId.get(k.other_claim_id as string);
      out.push({ at: k.at as number, kind: "clash", tone: "wait", fact: k.fact_id as string, text: `Clash warning, before anyone accepts either: ${b?.agent ?? "another attempt"}'s change breaks ${said(k.fact_id as string)}, which ${a?.agent ?? "another agent"}'s attempt makes true${hidden.has(k.fact_id as string) ? "" : ` (${String(k.detail).slice(0, 160)})`}. Not proof they can't coexist: the combination is judged again after a re-apply or repair` });
    }
    for (const t of this.rows(`SELECT * FROM trains ORDER BY created_at`)) {
      const riders = (JSON.parse(t.claims as string) as string[]).flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
      out.push({ at: t.created_at as number, kind: "train", tone: t.status === "landed" ? "good" : t.status === "failed" ? "bad" : "wait", text: `Merge train of ${riders.length}: ${riders.map((c) => `${c.agent} (${said(c.factId)})`).join(" + ")}: ${t.status}${t.detail ? `, ${String(t.detail).slice(0, 200)}` : ""}` });
    }
    const rows = this.rows(`SELECT * FROM canon ORDER BY seq`);
    for (const r of rows) {
      const seq = r.seq as number;
      const at = r.at as number;
      const sha = String(r.sha).slice(0, 12);
      if (r.reverts !== null && r.reverts !== undefined) {
        out.push({ at, kind: "revert", tone: "bad", sha, text: `Canon #${seq} steps back from #${r.reverts}: canon equals production again, and production never served #${r.reverts}` });
        continue;
      }
      const ids = r.facts_json ? (JSON.parse(r.facts_json as string) as string[]) : r.accepted_fact ? [r.accepted_fact as string] : [];
      const rec = this.acceptance(seq);
      if (!ids.length) out.push({ at, kind: "genesis", tone: "good", sha, text: `Canon #${seq}: genesis, the owner's first commit (${sha.slice(0, 7)})` });
      else out.push({ at, kind: "accept", tone: "good", sha, ...(rec ? { link: `/p/${project}/canon/${seq}/acceptance` } : {}), ...(rec?.judge ? { judge: rec.judge } : {}), text: `Canon #${seq}: ${ids.map((id) => said(id)).join(" + ")} accepted by ${rec?.authorizedBy ?? "the owner"}${rec?.chosenBecause ? `, chosen because ${rec.chosenBecause}` : ""}` });
      const revert = rows.find((x) => x.reverts === seq);
      const marks = [rec?.recovery.rehearsal?.at, rec?.recovery.candidateReset?.at, ...(rec?.exposure ?? []).map((e) => e.at)].filter((x): x is number => typeof x === "number");
      const done = revert ? (revert.at as number) - 1 : marks.length ? Math.max(...marks) : at + 1;
      if (!ids.length) continue;
      if (r.deployed === -1 || r.health === "held" || r.health === "rolled-back" || revert) out.push({ at: done, kind: "held", tone: "bad", sha, ...(rec ? { link: `/p/${project}/canon/${seq}/acceptance` } : {}), text: `Canon #${seq} ${r.health === "rolled-back" ? "rolled back" : "held back before production"}: ${String(r.health_detail ?? "its release didn't pass").slice(0, 300)}` });
      else if (r.deployed === 1) out.push({ at: done, kind: "release", tone: r.health === "broken" ? "bad" : "good", sha, ...(rec ? { link: `/p/${project}/canon/${seq}/acceptance` } : {}), text: `Canon #${seq} released${r.version_id ? ` as Worker version ${String(r.version_id).slice(0, 8)}` : ""}${rec?.recovery.rehearsal ? `; rollback rehearsal ${rec.recovery.rehearsal.state}` : ""}${(rec?.exposure ?? []).length ? `; rolled out ${rec!.exposure!.map((e) => `${e.percent}%`).join(" → ")} → 100%` : ""}${r.health === "broken" ? `; broken in production: ${r.health_detail}` : ""}` });
    }
    for (const f of facts.values()) if (f.declinedAt) out.push({ at: f.declinedAt, kind: "decline", tone: "bad", fact: f.id, text: `${said(f.id)} declined by the owner${f.declineReason ? `: “${f.declineReason}”` : ""}` });
    const order = ["genesis", "claim", "reapply", "push", "verdict", "clash", "train", "accept", "release", "held", "revert", "decline"];
    out.sort((x, y) => x.at - y.at || order.indexOf(x.kind) - order.indexOf(y.kind));
    return { project, from: out[0]?.at ?? null, to: out.at(-1)?.at ?? null, events: out };
  }

  /**
   * Before anything is installed or built, the toolchain and the deploy config must be canon's: an attempt that changes
   * the lockfile, .npmrc, the Wrangler config, files wrangler loads (.env, .dev.vars, .wrangler/) or anything under
   * node_modules is refused (publish.ts says why each matters). Returns why, or null. Genesis is the owner's own push; a
   * charter with "toolchain": "open" turns the guard off, on the owner's authority.
   */
  async buildGuard(repo: string, sha: string): Promise<string | null> {
    const attempt = this.attempt(repo);
    if (!attempt?.claimId || !attempt.baseSha || this.charter()?.toolchain === "open") return null;
    const changed = await this.changedPaths(attempt, sha);
    if (!changed) return "the judge couldn't list the files it changes, so nothing was installed or built; push again";
    for (const path of changed) {
      const why = ownerPath(path);
      if (why) return `${why}; revert it (the owner changes these, or opens the toolchain in the charter)`;
    }
    return null;
  }

  /**
   * What the publish step uploads with (publish.ts): the owner's Wrangler config, from the canon the attempt forked
   * from (an attempt can't change it, see buildGuard), unless the charter opened the toolchain to agents.
   */
  async publishTargetFor(repo: string, sha: string): Promise<PublishTarget> {
    const attempt = this.attempt(repo);
    const ref = attempt?.claimId && attempt.baseSha && this.charter()?.toolchain !== "open" ? attempt.baseSha : sha;
    for (const path of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
      // A read that fails is the platform's, not the attempt's: it throws, and the step retries.
      const text = await this.fileAtStrict(repo, ref, path);
      if (text !== null) return publishTarget(path, text);
    }
    return { refused: "there's no wrangler.jsonc or wrangler.json at the top of the repository" };
  }

  // ---- Move 2: declare --------------------------------------------------------------

  async declare(req: DeclareRequest): Promise<Declared> {
    const project = this.requireProject();
    const canon = this.currentCanon();
    if (!canon) throw new ProtocolError(409, "no canon yet: genesis attempt has not passed its seed facts");
    if (typeof req.agent !== "string" || !/^[\w.:@-]{1,40}$/.test(req.agent)) throw new ProtocolError(400, 'agent must be a name of 1-40 letters, digits or ". _ : @ -", e.g. "agent-3"');
    if (typeof req.why !== "string" || !req.why.trim()) throw new ProtocolError(400, "why is required: the reason for this change, in plain words");
    if (req.after !== undefined && (!Array.isArray(req.after) || req.after.length > 20 || req.after.some((id) => typeof id !== "string" || !this.fact(id)))) {
      throw new ProtocolError(400, 'after must list existing fact ids this attempt builds on, e.g. ["no-double-booking"]');
    }
    if (req.touches === undefined && this.charter()?.requireScope) throw new ProtocolError(400, 'the charter requires every claim to declare the files it will change: add touches, e.g. ["src/index.ts"] (CLI: --touches)');
    if (req.touches !== undefined && (!Array.isArray(req.touches) || !req.touches.length || req.touches.length > 50 || req.touches.some((g) => typeof g !== "string" || !g.trim()))) {
      throw new ProtocolError(400, 'touches must be a list of the file globs this attempt will change, e.g. ["src/index.ts"]');
    }

    let factId: string;
    if ("join" in req) {
      const fact = this.fact(req.join);
      if (!fact || fact.status !== "proposed") throw new ProtocolError(404, `no proposed fact "${req.join}" to join`);
      factId = fact.id;
    } else {
      const def = req.fact;
      if (typeof def?.id !== "string" || !/^[a-z0-9-]{3,48}$/.test(def.id)) throw new ProtocolError(400, 'a fact needs "id": a 3-48 char slug');
      if (typeof def.sentence !== "string" || !def.sentence.trim()) throw new ProtocolError(400, 'a fact needs "sentence": what must be true, in plain words');
      const existing = this.fact(def.id);
      if (existing?.status === "declined") throw new ProtocolError(409, `fact "${def.id}" was declined${existing.declineReason ? `: ${existing.declineReason}` : ""}`);
      if (existing) throw new ProtocolError(409, `fact "${def.id}" exists; join it instead`);
      validateCheck(def.check);
      validateScope(def.scope);
      if (def.replaces) {
        const old = this.fact(def.replaces);
        if (!old || old.status !== "canon") throw new ProtocolError(404, `a revision must replace a canon fact; "${def.replaces}" is not one`);
      }
      // A fact canon already satisfies is not new, and a check that cannot fail is not a fact.
      // (Command checks need CI: each push also runs them on the commit the attempt forked from.)
      const canonPreview = this.attempt(canon.attempt_id as string)?.previewUrl;
      if (canonPreview && def.check.kind === "probe") {
        const onCanon = await runCheck(def.check, canonPreview, `${canon.sha}:${def.id}`);
        if (onCanon.held) throw new ProtocolError(422, `"${def.sentence}" already holds on canon; it cannot fail, so it is not a new fact`);
      }
      factId = def.id;
    }

    const claimId = `c-${shortId()}`;
    const attemptId = `${project}-${shortId()}`;
    const { remote, token, expiresAt } = await this.forkAttempt(canon.attempt_id as string, attemptId, `${req.agent}: ${factId}`);
    const now = Date.now();
    // A new fact is written only once its attempt exists, and checked again here: another agent may have proposed
    // the same id while this one was forking.
    if (!("join" in req)) {
      if (this.fact(req.fact.id)) throw new ProtocolError(409, `fact "${req.fact.id}" exists; join it instead`);
      this.insertFact(req.fact, "proposed", "agent", now);
    }
    this.sql.exec(
      `INSERT INTO attempts (id, claim_id, remote, base_attempt, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      attemptId, claimId, remote, canon.attempt_id, canon.sha, now,
    );
    this.sql.exec(
      `INSERT INTO claims (id, agent, fact_id, why, attempt_id, status, created_at, touches_json, after_json) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      claimId, req.agent, factId, req.why, attemptId, now, req.touches ? JSON.stringify(req.touches) : null, req.after?.length ? JSON.stringify(req.after) : null,
    );
    if (!("join" in req)) this.sql.exec(`UPDATE facts SET proposed_by = ? WHERE id = ?`, claimId, factId);
    const replaced = req.replaces ? this.claim(req.replaces) : null;
    if (replaced && replaced.factId === factId && replaced.agent === req.agent && LIVE.includes(replaced.status)) this.setClaimStatus(replaced.id, "superseded");
    this.broadcast();
    return { claim: this.claim(claimId)!, attempt: { id: attemptId, remote, token, expiresAt, branch: "main" } };
  }

  // ---- Move 3: push (heard from the Artifacts push event) ----------------------------

  /** Records a push. Returns the attempt id if this repo is a Canon attempt that still accepts pushes. */
  pushed(repo: string, sha: string): string | null {
    const attempt = this.attempt(repo);
    if (!attempt || (attempt.frozen && attempt.claimId)) return null;
    // A settled claim's attempt (accepted, or replaced by a newer attempt) gets no more verdicts.
    const claim = attempt.claimId ? this.claim(attempt.claimId) : null;
    if (claim && claim.status !== "open" && !LIVE.includes(claim.status)) return null;
    this.sql.exec(`UPDATE attempts SET head_sha = ? WHERE id = ?`, sha, repo);
    this.sql.exec(`INSERT OR IGNORE INTO pushes (attempt_id, sha, at) VALUES (?, ?, ?)`, repo, sha, Date.now());
    if (attempt.claimId) this.setClaimStatus(attempt.claimId, "checking");
    this.broadcast();
    return repo;
  }

  /**
   * Admission control. Every verification builds in containers, and thirty starting at once overwhelmed the CI runner
   * (RPC sessions shut down, subrequest depth exceeded). So a project verifies at most VERIFY_SLOTS commits at a time;
   * the rest wait in the Workflow and come in as slots free. A slot is freed when the judge gets the result (or the
   * platform error), and expires after 15 minutes if its Workflow died.
   */
  async admit(repo: string, sha: string): Promise<"go" | "wait" | "stale"> {
    // A newer push of the same attempt makes this one pointless: its verdict would be replaced at once.
    const attempt = this.attempt(repo);
    if (attempt?.headSha && attempt.headSha !== sha && attempt.claimId) return "stale";
    const claimed = attempt?.claimId ? this.claim(attempt.claimId) : null;
    const agent = claimed?.agent ?? (attempt?.claimId ? repo : "the judge");
    // What it's worth: a fact the charter ranks first, then one people wrote (backlog), then the rest.
    const fact = claimed ? this.fact(claimed.factId) : null;
    // An attempt whose prerequisites aren't canon can't land yet: it goes last.
    const value = !fact ? 1 : claimed && this.pendingPrerequisites(claimed).length ? 0 : this.charter()?.priority?.includes(fact.id) ? 3 : fact.origin === "backlog" ? 2 : 1;
    const now = Date.now();
    const slots = JSON.parse(this.meta("verifying") ?? "{}") as Record<string, number | { at: number; agent: string }>;
    for (const [k, v] of Object.entries(slots)) if (now - (typeof v === "number" ? v : v.at) > 15 * 60_000) delete slots[k];
    const key = `${repo}:${sha}`;
    if (slots[key]) return "go";
    // Fair turns: a free slot goes to the waiting agent with the fewest builds running, then the one waiting longest,
    // so one agent pushing a lot can't starve the others.
    const waiting = JSON.parse(this.meta("waiting") ?? "{}") as Record<string, { agent: string; since: number; seen: number; value?: number }>;
    for (const [k, w] of Object.entries(waiting)) if (now - w.seen > 60_000) delete waiting[k];
    waiting[key] = { agent, since: waiting[key]?.since ?? now, seen: now, value };
    const running = (who: string) => Object.values(slots).filter((v) => typeof v !== "number" && v.agent === who).length;
    // Fewest builds running first (fairness), then the most valuable fact, then the longest wait.
    const next = Object.entries(waiting).sort(([, x], [, y]) => running(x.agent) - running(y.agent) || (y.value ?? 1) - (x.value ?? 1) || x.since - y.since)[0]?.[0];
    if (Object.keys(slots).length >= VERIFY_SLOTS || next !== key) {
      this.setMeta("waiting", JSON.stringify(waiting));
      this.setMeta("verifying", JSON.stringify(slots));
      return "wait";
    }
    this.setMeta("waiting", JSON.stringify(waiting));
    this.setMeta("verifying", JSON.stringify(slots));
    // The account's capacity, shared by every project: this project's turn also needs an account slot. If the
    // account object can't be reached, it waits (admission never fails open).
    if (this.env.CAPACITY) {
      const cap = await this.account().acquire(this.accountKey(key), this.requireProject(), ACCOUNT_SLOTS).catch(() => "wait" as const);
      if (cap !== "go") return "wait";
    }
    // Re-read: the await above let other admissions run.
    const fresh = JSON.parse(this.meta("verifying") ?? "{}") as Record<string, number | { at: number; agent: string }>;
    const queued = JSON.parse(this.meta("waiting") ?? "{}") as Record<string, unknown>;
    if (!fresh[key] && Object.keys(fresh).length >= VERIFY_SLOTS) {
      if (this.env.CAPACITY) this.ctx.waitUntil(this.account().release(this.accountKey(key)).catch(() => {}));
      return "wait";
    }
    delete queued[key];
    fresh[key] = { at: Date.now(), agent };
    this.setMeta("waiting", JSON.stringify(queued));
    this.setMeta("verifying", JSON.stringify(fresh));
    return "go";
  }

  private account() {
    return this.env.CAPACITY!.get(this.env.CAPACITY!.idFromName(`account#${this.env.REFEREE_EPOCH}`));
  }

  private accountKey(key: string) {
    return `${this.requireProject()}/${key}`;
  }


  /** Has a newer push of this attempt made this commit's verification pointless? If so its slot is freed. */
  superseded(repo: string, sha: string): boolean {
    const attempt = this.attempt(repo);
    const stale = !!attempt?.claimId && !!attempt.headSha && attempt.headSha !== sha;
    if (stale) this.releaseSlot(repo, sha);
    return stale;
  }

  private releaseSlot(repo: string, sha: string) {
    const slots = JSON.parse(this.meta("verifying") ?? "{}") as Record<string, unknown>;
    if (slots[`${repo}:${sha}`]) {
      delete slots[`${repo}:${sha}`];
      this.setMeta("verifying", JSON.stringify(slots));
    }
    if (this.env.CAPACITY) this.ctx.waitUntil(this.account().release(this.accountKey(`${repo}:${sha}`)).catch(() => {}));
  }

  /**
   * A proposed command fact must fail on the commit its attempt forked from, or it is not a new fact. CI rebuilds
   * that commit from the attempt's checkout with these files: each one the attempt changed, as it was at the fork.
   */
  async noveltyFor(repo: string, sha: string): Promise<Novelty | null> {
    const attempt = this.attempt(repo);
    const fact = attempt?.claimId ? this.fact(this.claim(attempt.claimId)?.factId ?? "") : null;
    if (!attempt?.baseSha || fact?.status !== "proposed" || fact.check.kind !== "command") return null;
    const changed = await this.changedPaths(attempt, sha);
    if (!changed) return null;
    using artifacts = await this.env.ARTIFACTS.get(attempt.id);
    const files: Novelty["files"] = [];
    let size = 0;
    for (const path of changed) {
      const blob = await artifacts.readFile({ ref: attempt.baseSha, path });
      const b64 = blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null;
      size += b64?.length ?? 0;
      if (size > NOVELTY_MAX_B64) return null;
      files.push({ path, b64 });
    }
    return { factId: fact.id, run: fact.check.run, files };
  }

  /**
   * The canon.json a new attempt must commit: canon's own file at the fork, plus the claimed fact (a revision drops
   * the fact it replaces; a backlog fact moves into the facts). This is what `canon claim` writes; MCP agents get it whole.
   */
  async attemptLedger(attemptId: string): Promise<string> {
    const attempt = this.attempt(attemptId);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    const fact = claim ? this.fact(claim.factId) : null;
    if (!attempt?.baseSha || !fact) throw new ProtocolError(404, `no claimed attempt "${attemptId}"`);
    using repo = await this.env.ARTIFACTS.get(attemptId);
    const blob = await repo.readFile({ ref: attempt.baseSha, path: "canon.json" });
    if (!blob) throw new ProtocolError(404, "the attempt has no canon.json");
    const ledger = JSON.parse(await blob.text()) as CanonFile;
    const def: FactDef = { id: fact.id, sentence: fact.sentence, check: fact.check };
    if (fact.scope?.length) def.scope = fact.scope;
    if (fact.replaces) def.replaces = fact.replaces;
    if (fact.replaces) ledger.facts = ledger.facts.filter((f) => f.id !== fact.replaces);
    if (Array.isArray(ledger.backlog)) ledger.backlog = ledger.backlog.filter((f) => f.id !== fact.id);
    if (ledger.backlog?.length === 0) delete ledger.backlog;
    if (!ledger.facts.some((f) => f.id === fact.id)) ledger.facts.push(def);
    return JSON.stringify(ledger, null, 2) + "\n";
  }

  /** Command facts the CI pipeline must run for this commit (lint, types, tests...), already filtered by scope. */
  async commandsFor(repo: string, sha: string): Promise<Array<{ factId: string; run: string }>> {
    const attempt = this.attempt(repo);
    if (!attempt) return [];
    // Before the first canon exists, genesis's own canon.json defines the facts.
    if (!attempt.claimId && !this.currentCanon()) {
      const file = await this.readCanonFile(repo, sha);
      if (!file.ok) return [];
      return [...file.facts, ...(file.backlog ?? [])].flatMap((f) => (f.check.kind === "command" ? [{ factId: f.id, run: f.check.run }] : []));
    }
    const claimedId = attempt.claimId ? this.claim(attempt.claimId)?.factId : undefined;
    const changed = await this.changedPaths(attempt, sha);
    return this.rows(`SELECT * FROM facts WHERE status IN ('canon', 'proposed')`)
      .map(toFact)
      .filter((f) => f.check.kind === "command" && (f.id === claimedId || inScope(f.scope, changed)))
      .map((f) => ({ factId: f.id, run: (f.check as { run: string }).run }));
  }

  // ---- Move 4: verdict --------------------------------------------------------------

  /**
   * Judges an attempt at a commit against canon. `commands` are the results of the command facts
   * the CI pipeline ran. Throws while the preview is not serving yet (the Workflow step retries).
   */
  async judge(repo: string, sha: string, previewUrl: string, commands: Record<string, CheckResult> = {}, notNew?: string): Promise<Verdict | null> {
    this.releaseSlot(repo, sha); // the containers are done with it
    const attempt = this.attempt(repo);
    if (!attempt) return null;
    // A claimed command fact that already passed on the commit its attempt forked from cannot fail: it is not new.
    if (notNew && commands[notNew]?.held) {
      commands = { ...commands, [notNew]: { held: false, detail: "it already passes on the commit this attempt forked from, so it can't fail: not a new fact", ms: 0 } };
    }
    if (attempt.headSha && attempt.headSha !== sha) return null; // a newer push will be judged instead
    this.sql.exec(`UPDATE attempts SET preview_url = ?, head_sha = ? WHERE id = ?`, previewUrl, sha, repo);
    await waitForPreview(previewUrl);

    // Before the first canon exists, genesis's own canon.json defines the facts, the backlog and the policy.
    const isGenesis = !attempt.claimId && !this.currentCanon();
    if (isGenesis) {
      const file = await this.readCanonFile(repo, sha);
      this.sql.exec(`DELETE FROM facts`);
      const now = Date.now();
      for (const f of file.ok ? file.facts : []) this.insertFact(f, "canon", "seed", now, now);
      for (const f of file.ok ? (file.backlog ?? []) : []) this.insertFact(f, "proposed", "backlog", now);
      const auto = file.ok ? file.policy?.autoAccept : undefined;
      this.setMeta("autoAccept", auto === "backlog" || auto === "charter" ? auto : "off");
      this.setMeta("charter", JSON.stringify(file.ok && file.policy?.charter ? file.policy.charter : null));
      this.setMeta("batch", file.ok && file.policy?.batch ? "1" : "0");
      this.setMeta("canary", JSON.stringify(file.ok && file.policy?.canary !== undefined ? file.policy.canary : null));
      this.setMeta("state", file.ok && file.policy?.state === "none" ? "none" : "unknown");
      if (file.ok && typeof file.production === "string" && /^https:\/\/[\w.-]+$/.test(file.production)) this.setMeta("productionUrl", file.production);
    }
    const verdict = await this.evaluate(this.attempt(repo)!, sha, previewUrl, undefined, commands);
    const train = this.rows(`SELECT * FROM trains WHERE id = ? AND status = 'judging'`, repo)[0];
    if (train) {
      await this.trainJudged(train, verdict);
      this.broadcast();
      return verdict;
    }

    // A genesis that didn't hold (a platform blip on a fresh preview, say) is re-checked by the alarm a few times.
    if (isGenesis && !(verdict.outcome === "ready" && verdict.kept.length > 0)) {
      const tries = Number(this.meta("genesisRetries") ?? 0);
      if (tries < 5) {
        this.setMeta("genesisRetries", String(tries + 1));
        const at = Date.now() + 30_000;
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      }
    }
    // Genesis becomes the first canon only if it declares facts and satisfies all of them.
    if (isGenesis && verdict.outcome === "ready" && verdict.kept.length > 0) {
      this.sql.exec(`INSERT INTO canon (attempt_id, sha, at, deployed, health) VALUES (?, ?, ?, 1, 'healthy')`, repo, sha, Date.now());
      this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, repo);
      await this.revokeWriteTokens(repo);
      await this.scheduleProductionCheck(20_000);
    }
    this.broadcast();
    // Clashes first: the charter needs them to pick a winner.
    await this.followUp(attempt.claimId, verdict);
    await this.autopilot(attempt.claimId, verdict);
    return verdict;
  }

  /** An attempt that does not build breaks every fact. */
  async buildFailed(repo: string, sha: string, detail: string): Promise<void> {
    this.releaseSlot(repo, sha);
    const train = this.rows(`SELECT * FROM trains WHERE id = ? AND status IN ('building', 'judging')`, repo)[0];
    if (train) return this.trainFailed(train, `the combined candidate didn't build: ${detail.slice(0, 160)}`);
    // The platform failed (the API answered with an error page, the network dropped): not the code's fault. It is
    // an error the judge retries itself, never a rejection.
    if (platformFailure(detail)) return this.couldNotJudge(repo, sha, `the build failed on the platform: ${detail.replace(/<[^>]*>/g, " ").slice(0, 160)}`);
    const attempt = this.attempt(repo);
    if (!attempt || (attempt.headSha && attempt.headSha !== sha)) return;
    await this.evaluate(attempt, sha, "", { held: false, detail: `build failed: ${detail.slice(0, 300)}`, ms: 0 });
    this.broadcast();
  }

  /** The platform failed (container capacity, RPC, Workflows), not the code: say so, and let the agent push again. */
  async couldNotJudge(repo: string, sha: string, detail: string): Promise<void> {
    this.releaseSlot(repo, sha);
    const train = this.rows(`SELECT * FROM trains WHERE id = ? AND status IN ('building', 'judging')`, repo)[0];
    if (train) return this.trainFailed(train, `the combined candidate couldn't be judged (platform): ${detail.slice(0, 160)}`);
    const attempt = this.attempt(repo);
    if (!attempt || (attempt.headSha && attempt.headSha !== sha)) return;
    const message = `could not be judged (platform error, not your code): ${detail.replace(/\s+/g, " ").slice(0, 200)}. Push again.`;
    const verdict: Verdict = {
      attemptId: repo, sha, previewUrl: "", canonSeq: (this.currentCanon()?.seq as number | undefined) ?? 0, outcome: "error",
      stale: [], kept: [], lost: [], retires: [], skipped: [], offers: [],
      claimed: { factId: attempt.claimId ? (this.claim(attempt.claimId)?.factId ?? "") : "", held: false, detail: message },
      ledger: { status: "ok", detail: "not read" }, judgedAt: Date.now(),
    };
    this.sql.exec(`INSERT OR REPLACE INTO verdicts (attempt_id, sha, json, at) VALUES (?, ?, ?, ?)`, repo, sha, JSON.stringify(verdict), verdict.judgedAt);
    if (attempt.claimId) this.setClaimStatus(attempt.claimId, "error");
    this.broadcast();
    // The judge retries platform errors itself (see retryPlatformErrors): wake up for it in a couple of minutes.
    void this.ctx.storage.getAlarm().then((current) => {
      const at = Date.now() + 125_000;
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
    });
  }

  /** Names of every Preview this project's verdicts used, so a reset can delete them. */
  previews(): string[] {
    const [head, tail] = this.env.PREVIEW_URL_TEMPLATE.split("{name}");
    const urls = this.rows(`SELECT DISTINCT json_extract(json, '$.previewUrl') AS url FROM verdicts`).map((r) => String(r.url ?? ""));
    return urls.filter((u) => u.startsWith(head) && u.endsWith(tail)).map((u) => u.slice(head.length, u.length - tail.length));
  }

  async verdict(attemptId: string): Promise<Verdict | null> {
    await this.catchUp(attemptId);
    const claimId = this.attempt(attemptId)?.claimId;
    const claim0 = claimId ? this.claim(claimId) : null;
    // Declined before anything was judged: say so instead of "pending".
    const verdict = this.latestVerdict(attemptId) ?? (claim0?.status === "declined"
      ? { attemptId, sha: "", previewUrl: "", canonSeq: this.canonSeq(), outcome: "pending", kept: [], lost: [], retires: [], skipped: [], stale: [], offers: [],
          claimed: { factId: claim0.factId, held: false, detail: "declined" }, ledger: { status: "ok", detail: "not read" }, judgedAt: Date.now() } satisfies Verdict
      : null);
    if (!verdict || !claimId) return this.redactVerdict(verdict, this.heldOutIds());
    const next = this.rows(`SELECT attempt_id FROM claims WHERE refreshed_from = ?`, claimId)[0]?.attempt_id as string | undefined;
    const claim = this.claim(claimId);
    // The diagnosis quotes failure details, so it's made from the redacted verdict: a held-out check never shows.
    const hiddenIds = this.heldOutIds();
    const redacted = this.redactVerdict(verdict, hiddenIds);
    return this.redactVerdict({
      ...verdict,
      diagnosis: claim && redacted ? this.diagnosisOf(claim, redacted) : null,
      clashes: this.clashesFor(claimId),
      headsUp: this.headsUpFor(claimId),
      reviewer: this.reviewOf(attemptId, verdict.sha),
      ...(next ? { refreshedAs: next } : {}),
      ...(claim?.status === "declined" ? { declined: claim.declineReason || "no reason given" } : {}),
    }, this.heldOutIds());
  }

  /** The verdict's diagnosis (see diagnosis.ts), from what the judge knows about the claim and its alternatives. */
  private diagnosisOf(claim: Claim, verdict: Verdict) {
    const prev = claim.refreshedFrom ? this.claim(claim.refreshedFrom) : null;
    const prevVerdict = prev ? this.latestVerdict(prev.attemptId) : null;
    const mine = assertionOf(verdict.claimed.detail);
    const sameFailureElsewhere = verdict.outcome !== "unproven" ? 0 : this.rows(`SELECT attempt_id FROM claims WHERE fact_id = ? AND id != ?`, claim.factId, claim.id)
      .map((r) => this.latestVerdict(r.attempt_id as string))
      .filter((v) => v?.outcome === "unproven" && assertionOf(v.claimed.detail) === mine).length;
    return diagnose(verdict, { reapplied: !!prev, passedBefore: prevVerdict?.outcome === "ready", sameFailureElsewhere });
  }

  /**
   * The push event is the only way the judge hears about a push, and very rarely one never arrives: the attempt
   * then waits forever. So when an agent asks for a verdict, look at the attempt's head (at most once a minute):
   * a commit pushed over 90 seconds ago that the judge never registered starts the same pipeline directly.
   */
  private async catchUp(attemptId: string) {
    const attempt = this.attempt(attemptId);
    if (!attempt || attempt.frozen || !attempt.claimId) return;
    const last = this.caughtUpAt.get(attemptId) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.caughtUpAt.set(attemptId, Date.now());
    try {
      using repo = await this.env.ARTIFACTS.get(attemptId);
      const [head] = await repo.log({ limit: 1 });
      if (!head || head.hash === attempt.headSha || head.hash === attempt.baseSha) return;
      if (Date.now() / 1000 - head.committedAt < 90) return; // its push event may still be on the way
      await this.env.CI_WORKFLOW.create({ id: `catchup-${attemptId}-${head.hash.slice(0, 12)}`, params: this.ciParams(attemptId, head.hash) });
    } catch {
      // Best effort: an instance with this id already exists, or the repo can't be read right now.
    }
  }

  // ---- Review and promotion ---------------------------------------------------------

  /** A person (or the autopilot policy) accepts a change in the facts. The attempt comes along as evidence and becomes canon. */
  async accept(claimId: string, how = "the owner", reason?: string) {
    const claim = this.claim(claimId);
    if (!claim) throw new ProtocolError(404, "no such claim");
    if (claim.status !== "ready") throw new ProtocolError(409, `claim is ${claim.status}, not ready`);
    if (this.fact(claim.factId)?.status !== "proposed") {
      this.setClaimStatus(claim.id, "superseded");
      this.broadcast();
      throw new ProtocolError(409, `"${claim.factId}" is no longer proposed; another attempt already settled it`);
    }
    const attempt = this.attempt(claim.attemptId)!;
    const verdict = this.latestVerdict(attempt.id);
    const canon = this.currentCanon()!;
    // One release at a time: until the last accept is released (or held back and reverted), canon may still move back.
    const releasing = this.releasing();
    if (releasing) throw new ProtocolError(409, `canon #${releasing} is being released; accept again once it's out (or held back)`);
    const train = this.activeTrain();
    if (train) throw new ProtocolError(409, `a merge train (${train.id}) is being checked; accept again once it lands or fails`);
    if (!verdict || verdict.sha !== attempt.headSha) throw new ProtocolError(409, "the attempt moved since its verdict; wait for the new one");
    // An attempt accepted once and then held back at release never lands as it is: its agent claims the fact again.
    if (attempt.frozen) throw new ProtocolError(409, "this attempt was held back at release; its agent claims the fact again with a fix");
    if (verdict.canonSeq !== canon.seq) {
      await this.evaluate(attempt, verdict.sha, verdict.previewUrl);
      this.broadcast();
      throw new ProtocolError(409, "canon moved since this verdict; re-judged, check the board");
    }

    // The owner may accept a change to a rule the charter locks; the history says it overrode the lock.
    const lockedRule = this.fact(claim.factId)?.replaces;
    if (how === "the owner" && lockedRule && this.charter()?.locked?.includes(lockedRule)) how = "the owner, overriding the charter’s lock";
    // Required evidence that failed or never arrived: only a person can accept over it, and the record names it.
    const evidence = this.evidenceFor(claim);
    const exceptions = [...this.exceptionsIn(evidence), ...this.pendingPrerequisites(claim).map((id) => `prerequisite “${this.fact(id)?.sentence ?? id}” isn't canon yet`)];
    const byOwner = how.startsWith("the owner");
    if (exceptions.length && !byOwner) throw new ProtocolError(409, `autopilot can't accept without the evidence the charter requires: ${exceptions.join("; ")}`);
    if (exceptions.length) how = `${how}, accepting despite: ${exceptions.join("; ")}`;
    // Every write happens before the first await, so a second accept can't slip in between: the attempt is frozen
    // (its pushes are ignored from here on), the fact is canon and the canon pointer has moved.
    const now = Date.now();
    const fact = this.fact(claim.factId)!;
    this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, attempt.id);
    this.sql.exec(`UPDATE facts SET status = 'canon', made_true_by = ?, accepted_at = ?, accepted_how = ? WHERE id = ?`, attempt.id, now, how, fact.id);
    // A revision retires the fact it replaces: the rule changed on purpose, and the history says who and why.
    if (fact.replaces) {
      this.sql.exec(`UPDATE facts SET status = 'retired', retired_by = ?, retired_at = ? WHERE id = ? AND status = 'canon'`, attempt.id, now, fact.replaces);
    }
    this.sql.exec(`INSERT INTO canon (attempt_id, sha, accepted_fact, at) VALUES (?, ?, ?, ?)`, attempt.id, verdict.sha, fact.id, now);
    this.recordAcceptance(attempt.id, verdict, [{ claim, verdict, evidence }], how, exceptions, now, reason?.trim() ? reason.trim().slice(0, 400) : byOwner ? undefined : how.replace(/^(the charter|autopilot): /, ""));
    this.setClaimStatus(claim.id, "accepted");
    this.sql.exec(
      `UPDATE claims SET status = 'superseded' WHERE fact_id = ? AND id != ? AND status NOT IN ('accepted', 'superseded')`,
      fact.id, claim.id,
    );

    const seq = this.currentCanon()!.seq as number;
    // Every other live attempt is now judged against the new canon. An attempt built before the fact is behind;
    // refreshed onto the new canon, an attempt that still loses it contradicts it: that is the conflict.
    this.setMeta("rejudge", "1");
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.broadcast();
    try {
      await this.env.PROMOTE_WORKFLOW.create({ id: `promote-${seq}-${verdict.sha.slice(0, 12)}`, params: this.ciParams(attempt.id, verdict.sha) });
    } catch {
      await this.promoted(seq, false);
    }
    await this.revokeWriteTokens(attempt.id);
    return { canonSeq: seq, attemptId: attempt.id, sha: verdict.sha };
  }

  /**
   * A person says no. The claim is settled; a fact an agent proposed that nobody else is working on is declined too,
   * with the reason kept in its history (as failed attempts are). A backlog fact people wrote stays in the backlog.
   */
  decline(claimId: string, reason: unknown) {
    const claim = this.claim(claimId);
    if (!claim) throw new ProtocolError(404, "no such claim");
    if (claim.status !== "open" && !LIVE.includes(claim.status)) throw new ProtocolError(409, `claim is ${claim.status}; only a claim still in flight can be declined`);
    const note = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
    this.sql.exec(`UPDATE claims SET status = 'declined', decline_reason = ? WHERE id = ?`, note || null, claim.id);
    const fact = this.fact(claim.factId);
    const others = this.rows(`SELECT id FROM claims WHERE fact_id = ? AND id != ? AND status IN ('open', ${LIVE.map(() => "?").join(",")})`, claim.factId, claim.id, ...LIVE);
    const factDeclined = fact?.status === "proposed" && fact.origin === "agent" && others.length === 0;
    if (factDeclined) this.sql.exec(`UPDATE facts SET status = 'declined', declined_at = ?, decline_reason = ? WHERE id = ?`, Date.now(), note || null, fact.id);
    this.broadcast();
    return { claim: this.claim(claim.id), factDeclined };
  }

  /**
   * The run report: what happened on this board, counted from the judge's own records. Nothing here is sampled or
   * estimated; every number is a row the judge wrote while judging.
   */
  stats() {
    const one = (q: string) => Number(this.rows(q)[0]?.n ?? 0);
    const claims = this.rows(`SELECT agent, status, refreshed_from, created_at FROM claims`);
    const facts = this.rows(`SELECT status, origin, accepted_how FROM facts`);
    const waits = this.rows(
      `SELECT v.first_at - p.at AS ms FROM pushes p JOIN verdicts v ON v.attempt_id = p.attempt_id AND v.sha = p.sha
       WHERE v.first_at IS NOT NULL AND v.first_at >= p.at ORDER BY ms`,
    ).map((r) => Number(r.ms));
    const pct = (p: number) => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(p * waits.length))] / 1000) : null);
    const pairs = new Set(this.rows(`SELECT claim_id, other_claim_id FROM clashes`).map((r) => [r.claim_id, r.other_claim_id].sort().join("|")));
    const accepted = facts.filter((f) => f.status === "canon" && f.origin !== "seed");
    const firstClaim = Math.min(...claims.map((c) => Number(c.created_at)));
    // Compute the judge times itself: every second from push to verdict (or from a mutation run's start to its end) is
    // priced as a busy standard-4 container (4 vCPU, 12 GiB, 20 GB) at Cloudflare's list price, ignoring the usage the
    // Workers Paid plan includes. Generous per second (part of it is the judge's probes, with no container running),
    // but partial: re-applies, trains and releases aren't timed here. Workflows' instance records have the full total.
    const runs = this.rows(`SELECT json FROM mutations`).map((r) => JSON.parse(r.json as string) as Mutation).filter((m) => m.status === "done");
    const mutationSeconds = runs.reduce((n, m) => n + (m.startedAt ? (m.at - m.startedAt) / 1000 : 0), 0);
    const verifySeconds = waits.reduce((n, ms) => n + ms / 1000, 0);
    const PER_SECOND = 4 * 0.00002 + 12 * 0.0000025 + 20 * 0.00000007;
    const lastVerdict = one(`SELECT MAX(at) AS n FROM verdicts`);
    return {
      agents: new Set(claims.map((c) => c.agent)).size,
      claims: claims.filter((c) => !c.refreshed_from).length,
      attempts: one(`SELECT COUNT(*) AS n FROM attempts WHERE claim_id IS NOT NULL`),
      pushes: one(`SELECT COUNT(*) AS n FROM pushes`),
      verdicts: one(`SELECT COUNT(*) AS n FROM verdicts`),
      checksRun: one(`SELECT COUNT(*) AS n FROM results`),
      rejected: claims.filter((c) => c.status === "contradicts").length,
      rejectedOnCombinedCode: claims.filter((c) => c.status === "contradicts" && c.refreshed_from).length,
      clashesCaught: pairs.size,
      reappliedByJudge: claims.filter((c) => c.refreshed_from).length,
      trainsLanded: one(`SELECT COUNT(*) AS n FROM trains WHERE status = 'landed'`),
      factsByTrain: this.rows(`SELECT claims FROM trains WHERE status = 'landed'`).reduce((n, t) => n + (JSON.parse(t.claims as string) as string[]).length, 0),
      heldBack: one(`SELECT COUNT(*) AS n FROM canon WHERE health = 'held'`),
      acceptedByPerson: accepted.filter((f) => String(f.accepted_how ?? "the owner").startsWith("the owner")).length,
      acceptedByPolicy: accepted.filter((f) => !String(f.accepted_how ?? "the owner").startsWith("the owner")).length,
      canonFacts: facts.filter((f) => f.status === "canon").length,
      verifyMinutes: Math.round(verifySeconds / 6) / 10,
      reviewer: this.reviewerRecord(),
      mutationRuns: runs.length,
      mutationMinutesMeasured: Math.round(mutationSeconds / 6) / 10,
      computeUsdEstimate: Math.round((verifySeconds + mutationSeconds) * PER_SECOND * 100) / 100,
      computeBasis: "only what the judge times itself: push-to-verdict seconds, plus mutation runs that recorded a start; each second priced as a busy standard-4 container at list price. Re-applies, trains and releases are not included (Workflows' own instance records have the full total)",
      medianSecondsToVerdict: pct(0.5),
      p90SecondsToVerdict: pct(0.9),
      minutes: Number.isFinite(firstClaim) && lastVerdict > firstClaim ? Math.round((lastVerdict - firstClaim) / 6000) / 10 : null,
      since: Number.isFinite(firstClaim) ? firstClaim : null,
    };
  }

  /** The current canon's number: a deploy of an older one is skipped. */
  canonSeq(): number {
    return (this.currentCanon()?.seq as number | undefined) ?? 0;
  }

  /** The canon still waiting for its release, if any (a stuck one stops blocking after 20 minutes). */
  private releasing(): number | null {
    const row = this.rows(`SELECT seq, at FROM canon WHERE accepted_fact IS NOT NULL AND deployed = 0 AND reverts IS NULL ORDER BY seq DESC LIMIT 1`)[0];
    if (!row) return null;
    // Releasing while its run holds the lease; before the run has taken it, for 20 minutes (the run is starting).
    const l = this.lease();
    if (l && l.seq === row.seq) return !l.ended && l.until > Date.now() ? (row.seq as number) : null;
    return Date.now() - Number(row.at) < RELEASE_START_MS ? (row.seq as number) : null;
  }

  /**
   * Who owns production's deployment (see deploymentOwner): the one rule every write outside a release run obeys. A
   * republish holds a lease on a canon that is already released, so ownership comes from the lease, not the canon row.
   */
  private productionOwner(): string | null {
    const row = this.rows(`SELECT seq, at FROM canon WHERE accepted_fact IS NOT NULL AND deployed = 0 AND reverts IS NULL ORDER BY seq DESC LIMIT 1`)[0];
    return deploymentOwner(this.lease(), row ? { seq: row.seq as number, at: Number(row.at) } : null, Date.now());
  }

  // The judge's own deployment writes (reconciliation, restore, rollback) and every release run's production write are
  // ordered through durable per-write accounting in the judge's storage (it survives an eviction or a restart):
  // - Judge writes are serialized: a new one waits until no earlier judge write is outstanding, then, in the same turn
  //   and with no await between, rechecks who owns production, registers itself and sends. A release or republish that
  //   took the lease during the wait owns production, and the judge backs off.
  // - Each write is registered under its own id. Its response settles only that write; an unknown outcome (a timeout,
  //   a lost connection) keeps only that write's quarantine. One write never clears another's protection.
  // - The release run's fence and the gate's writes wait until no judge write is outstanding, so no release or
  //   republish write, direct deploys included, can be overtaken by a judge write already on the wire.
  // The quarantine after an unknown outcome is a bounded-risk policy, not proof of settlement: a client timeout isn't a
  // cancellation, and Cloudflare documents no completion bound for a deployments API request, so after
  // UNKNOWN_WRITE_QUARANTINE_MS a write that never answered is presumed not to land. Only an answer settles a write.
  private judgeWrites(now = Date.now()): Record<string, number> {
    const all = JSON.parse(this.meta("judgeWrites") ?? "{}") as Record<string, number>;
    const legacy = Number(this.meta("judgeWriteUntil") ?? 0); // the single barrier an earlier version kept
    if (legacy > now) all.legacy = legacy;
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now));
  }

  private setJudgeWrite(id: string, until: number | null) {
    const all = JSON.parse(this.meta("judgeWrites") ?? "{}") as Record<string, number>;
    if (until === null) delete all[id];
    else all[id] = until;
    this.setMeta("judgeWrites", JSON.stringify(all));
  }

  /** Waits until no judge deployment write is outstanding (answered, or its quarantine ran out). */
  private async judgeWriteSettled() {
    for (;;) {
      const now = Date.now();
      const left = Math.min(...Object.values(this.judgeWrites(now)).map((until) => until - now));
      if (!Number.isFinite(left) || left <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(1_000, left)));
    }
  }

  /**
   * One judge deployment write (see above). `owner` is the authority check, made after any wait and right before the
   * request goes out. Returns null when someone else owns production by then (nothing was sent).
   */
  private async judgeWrite(api: string, init: RequestInit, owner: () => string | null): Promise<Response | null> {
    await this.judgeWriteSettled();
    // From here to fetch() there is no await: the check, the registration and the send happen in one turn.
    if (Object.keys(this.judgeWrites()).length) return this.judgeWrite(api, init, owner);
    if (owner() !== null) return null;
    const id = crypto.randomUUID();
    this.setJudgeWrite(id, writeBarrier("sending", Date.now()));
    let res: Response;
    try {
      res = await fetch(api, { ...init, signal: AbortSignal.timeout(JUDGE_WRITE_MS) });
    } catch (err) {
      this.setJudgeWrite(id, writeBarrier("unknown", Date.now()));
      throw err;
    }
    this.setJudgeWrite(id, null);
    return res;
  }

  async promoted(seq: number, ok: boolean, versionId: string | null = null, holder?: string) {
    // A run that no longer holds the release (stalled, then fenced out) is ignored, and if it changed production
    // anyway, production goes back to the version canon says it runs.
    if (holder && !this.holds(seq, holder)) {
      if (ok && versionId) await this.restoreProduction(`a stale release run of canon #${seq} deployed after it was fenced out`).catch(() => {});
      return;
    }
    if (holder) this.endLease(seq, ok ? "released" : "not released");
    if (ok) this.markCandidate(null); // the candidate ran the code production now runs
    this.sql.exec(`UPDATE canon SET deployed = ?, version_id = COALESCE(?, version_id) WHERE seq = ?`, ok ? 1 : -1, versionId, seq);
    // Canon is what production runs. A canon that wasn't released goes back to the last one that was.
    if (!ok) {
      const row = this.rows(`SELECT health_detail, health FROM canon WHERE seq = ?`, seq)[0];
      await this.revertCanon(seq, row?.health === "held" ? (row.health_detail as string) : null);
    }
    // The queue moves: Ready claims waiting on the release are judged (and autopiloted) against the canon now live.
    this.setMeta("rejudge", "1");
    if (Number(this.meta("boardingUntil") ?? 0)) this.setMeta("boardingUntil", String(Date.now() + 5_000));
    // Production just changed: check canon's facts on it shortly, once the new version is serving. That first check
    // decides whether this deploy is healthy (see checkCanonOnProduction).
    if (ok) this.setMeta("verifyDeploy", String(seq));
    await this.scheduleProductionCheck(20_000);
    if (ok) await this.retryConflicts().catch(() => {});
    // A speculative train checked on this canon: it lands now if the release went out, and fails if it was held back.
    for (const t of this.rows(`SELECT * FROM trains WHERE status = 'waiting' AND base_seq = ?`, seq)) {
      const v = this.latestVerdict(t.id as string);
      if (ok && v) await this.trainJudged(t, v).catch(() => {});
      else await this.trainFailed(t, `it was checked on canon #${seq}, which ${ok ? "had no verdict" : "was held back at release"}, so its riders land one at a time`).catch(() => {});
    }
    this.broadcast();
  }

  // One alarm, two jobs: re-judging live attempts after canon moves, and checking canon's facts on production hourly.
  async alarm() {
    // A board from an earlier epoch (before a reset) is no longer anyone's judge: it must not keep checking, or
    // rolling back, the production it once watched. It stops its own alarm for good.
    const project = this.meta("project");
    if (project && !this.ctx.id.equals(this.env.REFEREE.idFromName(`${project}#${this.env.REFEREE_EPOCH}`))) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    try {
      // No canon yet: re-judge genesis on its preview (judge() makes it canon once every fact holds).
      if (!this.currentCanon() && Number(this.meta("genesisRetries") ?? 0) > 0) {
        const id = this.rows(`SELECT id FROM attempts WHERE claim_id IS NULL AND preview_url IS NOT NULL ORDER BY created_at LIMIT 1`)[0]?.id as string | undefined;
        const g = id ? this.attempt(id) : null;
        if (g?.headSha && g.previewUrl) await this.judge(g.id, g.headSha, g.previewUrl).catch(() => {});
        return;
      }
      await this.keepCanonReleased().catch(() => {});
      await this.reconcileProduction().catch(() => {});
      await this.depart().catch(() => {});
      await this.retryPlatformErrors().catch(() => {});
      for (const t of this.rows(`SELECT * FROM trains WHERE status IN ('building', 'judging', 'waiting') AND created_at < ?`, Date.now() - 20 * 60_000)) {
        await this.trainFailed(t, "it was still being checked after 20 minutes").catch(() => {});
      }
      for (const c of this.rows(`SELECT * FROM claims WHERE status = 'ready' ORDER BY created_at LIMIT 20`).map(toClaim)) {
        const v = this.latestVerdict(c.attemptId);
        if (!v) continue;
        await this.startMutation(c.id, v).catch(() => {});
        // A review that never finished (a deploy or an eviction cut it off) gets one more try; after that it stays
        // unavailable. Either way autopilot looks again, so a wait that timed out says so instead of "reading".
        const r = this.charter()?.reviewRisk || this.charter()?.intentRisk ? this.reviewOf(c.attemptId, v.sha) : null;
        if (r?.status === "running" && Date.now() - r.at > REVIEW_STUCK_MS && !r.detail) {
          this.sql.exec(`DELETE FROM reviews WHERE attempt_id = ? AND sha = ?`, c.attemptId, v.sha);
          this.ctx.waitUntil(this.startReview(c.id, v, true).catch(() => {}));
        } else if (c.autoWait) await this.autopilot(c.id, v).catch(() => {});
      }
      // An alarm set before the production check existed was a re-judge.
      if (this.meta("rejudge") === "1" || this.meta("prodCheckAt") === null) {
        this.setMeta("rejudge", "0");
        const live = this.rows(`SELECT * FROM claims WHERE status IN (${LIVE.map(() => "?").join(",")})`, ...LIVE).map(toClaim);
        const judged: Array<[string, Verdict]> = [];
        for (const claim of live) {
          const attempt = this.attempt(claim.attemptId);
          const judgedOn = attempt ? this.judgedPreview(attempt) : null;
          // A newer push that is still building gets its own verdict against the new canon. A frozen attempt was
          // accepted: if it's live again, it was held back at release, and its verdict stays (the agent claims anew).
          if (!attempt || !judgedOn || attempt.frozen) continue;
          try {
            judged.push([claim.id, await this.evaluate(attempt, judgedOn.sha, judgedOn.previewUrl)]);
          } catch {
            // One attempt that can't be re-judged right now must not stop the rest.
          }
        }
        this.broadcast();
        for (const [claimId, verdict] of judged) await this.followUp(claimId, verdict);
        for (const [claimId, verdict] of judged) await this.autopilot(claimId, verdict);
      }
      const canon = this.currentCanon();
      if (canon && Date.now() >= Number(this.meta("prodCheckAt") ?? 0)) {
        // While an accepted attempt is still deploying, production runs the old canon: wait for promoted().
        const deploying = canon.accepted_fact !== null && canon.deployed === 0;
        this.setMeta("prodCheckAt", String(Date.now() + (deploying ? 5 * 60_000 : PRODUCTION_CHECK_EVERY_MS)));
        if (!deploying) await this.checkCanonOnProduction().catch(() => {});
        // Previews don't change, but the set of Ready claims does: recheck their clashes on the same schedule.
        for (const r of this.rows(`SELECT id FROM claims WHERE status IN ('ready', 'unproven')`)) await this.findClashes(r.id as string).catch(() => {});
      }
      this.broadcast();
    } finally {
      // A fact accepted while this alarm ran needs its re-judge now, not at the next production check.
      const boarding = Number(this.meta("boardingUntil") ?? 0);
      const next = this.meta("rejudge") === "1" ? Date.now() + 1_000 : Number(this.meta("prodCheckAt") ?? 0);
      const soonest = [next, boarding ? Math.max(boarding, Date.now() + 1_000) : 0].filter(Boolean);
      // Something this run did may already have set an earlier wake-up (a platform error retry): keep that one.
      const pending = await this.ctx.storage.getAlarm();
      if (soonest.length && (pending === null || pending > Math.min(...soonest))) await this.ctx.storage.setAlarm(Math.min(...soonest));
    }
  }

  /** The commit an attempt's last verdict judged and that commit's own Preview, if that commit is still its head. */
  private judgedPreview(attempt: Attempt): { sha: string; previewUrl: string } | null {
    const last = this.latestVerdict(attempt.id);
    return last?.previewUrl && last.sha === attempt.headSha ? { sha: last.sha, previewUrl: last.previewUrl } : null;
  }

  /**
   * Runs every canon probe fact against production, one at a time so latency budgets don't skew each other.
   * The first check after a deploy decides that deploy's health: every fact held, it's healthy; a fact broke (twice, to
   * rule out a blip), it's broken, and production rolls back to the last healthy version. Later hourly checks only
   * report: a fact that breaks long after a deploy is not evidence against that deploy's code.
   */
  private async checkCanonOnProduction() {
    const url = this.productionUrl();
    const results: Record<string, { held: boolean; detail: string }> = {};
    const facts = this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact).filter((f) => f.check.kind === "probe");
    for (const f of facts) {
      const r = await runCheck(f.check as ProbeCheck, url);
      results[f.id] = { held: r.held, detail: r.detail };
    }
    const verifying = Number(this.meta("verifyDeploy") ?? 0);
    const live = this.rows(`SELECT * FROM canon WHERE deployed = 1 ORDER BY seq DESC LIMIT 1`)[0];
    if (live && verifying === live.seq) {
      this.setMeta("verifyDeploy", "0");
      for (const f of facts.filter((x) => !results[x.id].held)) {
        await new Promise((r) => setTimeout(r, 3_000));
        const again = await runCheck(f.check as ProbeCheck, url);
        if (again.held) results[f.id] = { held: true, detail: again.detail };
      }
      const broke = facts.filter((f) => !results[f.id].held);
      // Only Cloudflare's edge (or nobody) answered: the app wasn't reached, so nothing is known about the code. Look
      // again every minute for ten minutes; rolling back can't fix an edge that isn't serving yet.
      const tries = Number(this.meta("verifyTries") ?? 0);
      if (broke.length && broke.every((f) => edgeFailure(results[f.id].detail))) {
        if (tries < 10) {
          this.setMeta("verifyTries", String(tries + 1));
          this.setMeta("verifyDeploy", String(live.seq));
          this.setMeta("production", JSON.stringify({ at: Date.now(), url, results }));
          return void (await this.scheduleProductionCheck(60_000));
        }
        this.setMeta("verifyTries", "0");
        this.sql.exec(`UPDATE canon SET health = 'unverified', health_detail = ? WHERE seq = ?`, `production didn't answer for ten minutes (${results[broke[0].id].detail}); nothing was rolled back`, live.seq);
      } else if (!broke.length) {
        this.setMeta("verifyTries", "0");
        this.sql.exec(`UPDATE canon SET health = 'healthy', health_detail = NULL WHERE seq = ?`, live.seq);
      } else {
        this.setMeta("verifyTries", "0");
        const what = `broke “${broke[0].sentence}” in production: ${results[broke[0].id].detail}`;
        this.sql.exec(`UPDATE canon SET health = 'broken', health_detail = ? WHERE seq = ?`, what, live.seq);
        // Roll back only when that's known to be safe: after a destructive schema change, the earlier version would
        // run on data it no longer understands. The owner decides (a fix forward, or a rollback with a data repair).
        const recovery = this.acceptance(live.seq as number)?.recovery;
        if (recovery && !recovery.rollbackSafe) {
          this.sql.exec(`UPDATE canon SET health_detail = ? WHERE seq = ?`, `${what}. Not rolled back automatically: ${recovery.how}`, live.seq);
        } else await this.rollBack(live, what);
      }
    } else if (live && !live.health && facts.every((f) => results[f.id].held)) {
      this.sql.exec(`UPDATE canon SET health = 'healthy' WHERE seq = ?`, live.seq);
    }
    this.setMeta("production", JSON.stringify({ at: Date.now(), url, results }));
  }

  /**
   * Canon always equals what production runs. When canon #seq is not released (held back by the release candidate or
   * the 0% gate, or rolled back afterwards), the canon pointer goes back to the last released canon as a new canon
   * entry that says it reverts #seq. The accepted fact is proposed again (a rule it retired comes back), the claim gets
   * a verdict that says what broke where (or, if only the platform failed, it is Ready again), claims superseded by the
   * accept are live again, and every attempt that forked from the reverted canon is re-applied on the restored one, so
   * nothing keeps the code that never shipped.
   */
  private async revertCanon(seq: number, brokeAt: string | null) {
    const current = this.currentCanon();
    if (!current || current.seq !== seq || current.reverts) return;
    const back = this.rows(
      `SELECT * FROM canon WHERE seq < ? AND reverts IS NULL AND (accepted_fact IS NULL OR deployed = 1)
         AND COALESCE(health, '') NOT IN ('held', 'broken', 'rolled-back') ORDER BY seq DESC LIMIT 1`,
      seq,
    )[0];
    if (!back) return;
    // Every canon above the last released one never shipped: undo them all (normally just this one).
    const undone = this.rows(`SELECT * FROM canon WHERE seq > ? AND seq <= ? AND accepted_fact IS NOT NULL AND reverts IS NULL ORDER BY seq DESC`, back.seq, seq);
    this.sql.exec(
      `INSERT INTO canon (attempt_id, sha, accepted_fact, deployed, at, version_id, health, reverts) VALUES (?, ?, NULL, 1, ?, ?, 'healthy', ?)`,
      back.attempt_id, back.sha, Date.now(), back.version_id ?? null, seq,
    );
    const facts = this.rows(`SELECT id, sentence FROM facts`);
    // Each undone canon's facts (a merge train lands several) and the claims that made them true.
    const accepts = undone.map((row) => {
      const factIds = row.facts_json ? (JSON.parse(row.facts_json as string) as string[]) : [row.accepted_fact as string];
      const claims = factIds.map((factId) =>
        row.facts_json
          ? this.rows(`SELECT * FROM claims WHERE fact_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1`, factId).map(toClaim)[0]
          : this.rows(`SELECT * FROM claims WHERE attempt_id = ?`, row.attempt_id).map(toClaim)[0],
      );
      return { row, factIds, claims };
    });
    // The undone accepts' own claims go back to their agents; only bystanders that forked from them are re-applied.
    const undoneAttempts = accepts.flatMap((u) => [u.row.attempt_id as string, ...u.claims.flatMap((c) => (c ? [c.attemptId] : []))]);
    for (const { row, factIds, claims } of accepts) {
      const why = row.seq === seq ? brokeAt : ((row.health_detail as string | null) ?? null);
      // A merge train held back at release: its riders try again as two halves (or one by one), see splitTrain.
      if (why && factIds.length > 1) this.splitTrain(claims.flatMap((c) => (c ? [c.id] : [])));
      for (const [k, factId] of factIds.entries()) {
      const fact = this.fact(factId);
      this.sql.exec(`UPDATE facts SET status = 'proposed', accepted_at = NULL, made_true_by = NULL, accepted_how = NULL WHERE id = ?`, factId);
      if (fact?.replaces) this.sql.exec(`UPDATE facts SET status = 'canon', retired_by = NULL, retired_at = NULL WHERE id = ? AND retired_by = ?`, fact.replaces, row.attempt_id);
      // The claim that was accepted: back to its agent with what broke, or Ready again if only the platform failed.
      const claim = claims[k];
      const verdict = claim ? this.latestVerdict(claim.attemptId) : null;
      // A merge train held back at release doesn't say which rider broke it: its riders are Ready again and retry in
      // halves (or one by one), so the release gate finds the one that breaks.
      if (claim && verdict && why && factIds.length > 1) {
        this.sql.exec(`UPDATE attempts SET frozen = 0 WHERE id = ?`, claim.attemptId);
        this.setClaimStatus(claim.id, "ready");
      } else if (claim && verdict) {
        if (!why) this.sql.exec(`UPDATE attempts SET frozen = 0 WHERE id = ?`, claim.attemptId); // only the platform failed: it may land again
        const brokeFact = why ? ((facts.find((f) => why.includes(`“${f.sentence}”`))?.id as string | undefined) ?? "release") : "";
        const v: Verdict = why
          ? { ...verdict, outcome: "contradicts", heldBack: why, lost: [...verdict.lost.filter((l) => !l.detail.startsWith("at release")), { factId: brokeFact, detail: `at release, ${why}` }] }
          : { ...verdict, heldBack: undefined };
        this.sql.exec(`UPDATE verdicts SET json = ? WHERE attempt_id = ? AND sha = ?`, JSON.stringify(v), verdict.attemptId, verdict.sha);
        this.setClaimStatus(claim.id, why ? "contradicts" : "ready");
      }
      // Claims the accept superseded race for the fact again.
      for (const c of this.rows(
        `SELECT * FROM claims c WHERE c.fact_id = ? AND c.status = 'superseded' AND c.id != ?
           AND NOT EXISTS (SELECT 1 FROM claims n WHERE n.refreshed_from = c.id
             OR (n.fact_id = c.fact_id AND n.agent = c.agent AND n.created_at > c.created_at AND n.id != ?))`,
        factId, claim?.id ?? "", claim?.id ?? "",
      ).map(toClaim)) {
        this.setClaimStatus(c.id, (this.latestVerdict(c.attemptId)?.outcome as ClaimStatus | undefined) ?? "open");
      }
      }
      // Attempts built on a reverted canon carry its code: re-apply their own change on the restored canon.
      const onReverted = this.rows(
        `SELECT c.id FROM claims c JOIN attempts a ON a.id = c.attempt_id WHERE a.base_attempt = ? AND c.status IN (${LIVE.map(() => "?").join(",")})
           AND a.id NOT IN (${undoneAttempts.map(() => "?").join(",")})`,
        row.attempt_id, ...LIVE, ...undoneAttempts,
      );
      for (const r of onReverted) {
        this.sql.exec(`UPDATE claims SET status = 'behind', refresh = NULL WHERE id = ?`, r.id);
        await this.autoRefresh(r.id as string).catch(() => {});
      }
    }
    this.setMeta("rejudge", "1");
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.broadcast();
  }

  /** Owner: apply the invariant now instead of at the next alarm. */
  async reconcile() {
    // No canon yet: genesis gets re-checked on its preview by the alarm.
    if (!this.currentCanon()) {
      this.setMeta("genesisRetries", "1");
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return { canonSeq: null, reverted: false, genesis: "re-checking" };
    }
    const before = this.currentCanon()?.seq;
    await this.keepCanonReleased();
    this.setMeta("rejudge", "1"); // Ready claims are judged (and autopiloted) again, under the rules as they are now
    await this.retryConflicts().catch(() => {});
    await this.ctx.storage.setAlarm(Date.now() + 1_000); // and run the rest of the alarm's work (retries, mutation runs) now
    return { canonSeq: this.currentCanon()?.seq, reverted: this.currentCanon()?.seq !== before };
  }

  /**
   * A verdict of "error" is the platform's fault (a container dropped, CI ran out of retries), never the code's. An agent
   * would push again; the judge does that itself, re-running verification on the same commit, three times at most,
   * two minutes apart, so attempts the judge made (re-applies) don't wait for an agent that has gone home.
   */
  private async retryPlatformErrors() {
    const tries = JSON.parse(this.meta("errorRetries") ?? "{}") as Record<string, { n: number; at: number }>;
    for (const c of this.rows(`SELECT * FROM claims WHERE status = 'error'`).map(toClaim)) {
      const a = this.attempt(c.attemptId);
      if (!a?.headSha || a.frozen) continue;
      const t = tries[`${a.id}:${a.headSha}`] ?? { n: 0, at: 0 };
      if (t.n >= 3 || Date.now() - t.at < 120_000) continue;
      tries[`${a.id}:${a.headSha}`] = { n: t.n + 1, at: Date.now() };
      try {
        await this.env.CI_WORKFLOW.create({ id: `retry-${a.id}-${a.headSha.slice(0, 12)}-${t.n + 1}`, params: this.ciParams(a.id, a.headSha) });
        this.setClaimStatus(c.id, "checking");
      } catch {
        // the next alarm tries again
      }
    }
    this.setMeta("errorRetries", JSON.stringify(Object.fromEntries(Object.entries(tries).slice(-300))));
  }

  /** The invariant, checked on every alarm: the current canon was released. If not (held back, rolled back, or the deploy failed), revert. */
  private async keepCanonReleased() {
    const cur = this.currentCanon();
    if (!cur?.accepted_fact || cur.reverts) return;
    // A release that never reported back (its Workflow ended without recording, e.g. an RPC that kept failing): ask
    // production. The facts it accepted fail on the old code (that's what made them new), so if they hold there, it
    // went out; if not, it didn't, and canon goes back.
    // Its run stalled past its lease (or never took one): the run is fenced out from here, whatever its own status.
    if (cur.deployed === 0 && this.releasing() === null) {
      this.endLease(cur.seq as number, "its run stalled past its lease; the judge settled it from what production runs");
      const url = this.productionUrl();
      const ids = cur.facts_json ? (JSON.parse(cur.facts_json as string) as string[]) : [cur.accepted_fact as string];
      const probes = ids.map((id) => this.fact(id)).filter((f): f is Fact => f?.check.kind === "probe");
      const live = probes.length > 0 && (await Promise.all(probes.map((f) => runCheck(f.check as ProbeCheck, url)))).every((r) => r.held);
      if (live) this.sql.exec(`UPDATE canon SET deployed = 1 WHERE seq = ?`, cur.seq);
      else {
        this.sql.exec(`UPDATE canon SET deployed = -1, health_detail = ? WHERE seq = ?`, "its release never finished, and production still runs the previous canon", cur.seq);
        await this.revertCanon(cur.seq as number, null);
      }
      return;
    }
    if (cur.deployed === -1 || cur.health === "held" || cur.health === "rolled-back") {
      await this.revertCanon(cur.seq as number, cur.health === "held" || cur.health === "rolled-back" ? (cur.health_detail as string) : null);
    }
  }

  /**
   * Release step one: the release candidate. The accepted commit was deployed in full to its own Worker
   * ({project}-candidate) with production's config, so every canon fact runs on all of its code, Durable Object code
   * included, before production is touched. A fact that breaks there holds the canon back.
   */
  async candidateCheck(seq: number): Promise<boolean> {
    const project = this.requireProject();
    const url = this.env.CANDIDATE_URL.replace("{project}", project);
    // The candidate was deployed seconds ago: let its rollout settle (Durable Objects pick up new code eventually).
    await new Promise((ok) => setTimeout(ok, 20_000));
    const broke = await this.factsOn(seq, url, {}, undefined, true);
    if (!broke.length) {
      // The rehearsal's state continuity: every fact runs once more on this release's code under one shared run
      // identity, writing the state the previous version will be asked to read (see rehearsalCheck).
      if (this.acceptance(seq)?.recovery.rehearse) await this.continuityRun(seq, url, `reh-${seq}`);
      return true;
    }
    const what = `broke “${broke[0].fact.sentence}” on its release candidate (a full copy with production’s config): ${broke[0].detail}`;
    this.sql.exec(`UPDATE canon SET health = 'held', health_detail = ? WHERE seq = ?`, `${what}. Held back: production never served it.`, seq);
    this.broadcast();
    return false;
  }

  /**
   * Every canon probe fact on `url` (with `extra` headers), each re-tried once. The accepted fact fails on the old code
   * (that's what made it a new fact), so the run waits until it holds: proof the new code is the code answering.
   */
  private async factsOn(seq: number, url: string, extra: Record<string, string>, seedPrefix?: string, firstOnly = false, only?: Fact[]): Promise<Array<{ fact: Fact; detail: string }>> {
    // With a seed prefix, every fact draws the same inputs on every run (so two runs can be compared exactly).
    const seedOf = (f: Fact) => (seedPrefix ? `${seedPrefix}:${f.id}` : undefined);
    const acceptedId = only ? null : this.rows(`SELECT accepted_fact FROM canon WHERE seq = ?`, seq)[0]?.accepted_fact;
    const facts = (only ?? this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact)).filter((f) => f.check.kind === "probe");
    const accepted = facts.find((f) => f.id === acceptedId);
    for (let i = 0; accepted && i < 6; i++) {
      await new Promise((r) => setTimeout(r, i ? 5_000 : 3_000));
      if ((await runCheck(accepted.check as ProbeCheck, url, seedOf(accepted), extra)).held) break;
    }
    const broke: Array<{ fact: Fact; detail: string }> = [];
    for (const f of facts) {
      let r = await runCheck(f.check as ProbeCheck, url, seedOf(f), extra);
      // Cloudflare's edge answering instead of the app (a 52x/530) never counts: wait for the app, ~2 minutes.
      for (let i = 0; !r.held && edgeFailure(r.detail) && i < 8; i++) {
        await new Promise((ok) => setTimeout(ok, 15_000));
        r = await runCheck(f.check as ProbeCheck, url, seedOf(f), extra);
      }
      // A fact holds a release back only if it fails every time, over about 45 seconds: right after a deploy, a Durable
      // Object can still be switching to the new code and drop a request (an intermittent 500). A real break (a
      // missing migration, a wrong price) fails on every try.
      for (const wait of [3_000, 15_000, 30_000]) {
        if (r.held) break;
        await new Promise((ok) => setTimeout(ok, wait));
        r = await runCheck(f.check as ProbeCheck, url, seedOf(f), extra);
      }
      if (!r.held) broke.push({ fact: f, detail: r.detail });
      // One fact that fails every time is enough to hold a release back; checking the rest only delays the verdict.
      if (firstOnly && broke.length) return broke;
    }
    return broke;
  }

  /**
   * Release step two: the judge is the one writer of production's deployment. The release run uploaded the exact
   * commit as a Worker version that serves nobody; this puts it in front of traffic. Every deployment write checks,
   * in the same turn and right before the request, that the run still holds the release: a run that lost it makes no
   * write at all, not even a rollback (the judge's own reconciliation then puts production on canon's version, read
   * from the current state). With `smoke` (a Worker without Durable Objects), it first stages the version at 0% next to
   * the one production runs, runs every canon fact on the production URL pinned to it (the version-override header),
   * and only then gives it 100%; a version that breaks a fact is taken back out and never serves anyone. The accepted
   * fact fails on the old version (that's what made it new), so it holding there also proves the override reached the
   * new version. Code inside a Durable Object runs on its object's version, so a 0% test can't reach it: there the
   * release candidate already ran it in full, and the version goes straight to 100%.
   */
  async gate(seq: number, versionId: string, holder?: string, smoke = true): Promise<{ released: boolean; detail: string }> {
    const project = this.requireProject();
    const api = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${project}/deployments`;
    const headers = { authorization: `Bearer ${this.env.CF_TOKEN}`, "content-type": "application/json" };
    const FENCED = "fenced out: this run no longer holds the release, so it makes no deployment write (the judge reconciles production)";
    class Fenced extends Error {}
    const write = async (versions: Array<{ version_id: string; percentage: number }>, message: string) => {
      // A judge write already on the wire lands (or its quarantine passes) first; checked again after each wait, then
      // the lease check and the request go out in the same turn.
      await this.judgeWriteSettled();
      while (Object.keys(this.judgeWrites()).length) await this.judgeWriteSettled();
      if (holder !== undefined && !this.holds(seq, holder)) throw new Fenced();
      const res = await fetch(api, { method: "POST", headers, body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } }) });
      if (!res.ok) throw new Error(`deployments API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
    const liveNow = async () =>
      (await (await fetch(api, { headers })).json<{ result?: { deployments?: Array<{ versions: Array<{ version_id: string; percentage: number }> }> } }>()).result?.deployments?.[0]?.versions ?? [];
    try {
      await this.judgeWriteSettled(); // read the deployment after any judge write in flight lands
      while (Object.keys(this.judgeWrites()).length) await this.judgeWriteSettled();
      const live = await liveNow();
      const current = (live.find((v) => v.percentage === 100) ?? live[0])?.version_id;
      if (!smoke || !current || current === versionId) {
        await write([{ version_id: versionId, percentage: 100 }], `Canon #${seq}: released${smoke ? " (nothing to stage beside)" : " (its release candidate ran it in full)"}`);
        return { released: true, detail: smoke ? "released with nothing to stage beside" : "released after its release candidate" };
      }
      await write([{ version_id: versionId, percentage: 0 }, { version_id: current, percentage: 100 }], `Canon #${seq}: staged at 0% for its smoke test`);
      const url = this.productionUrl();
      const pin = { "cloudflare-workers-version-overrides": `${project}="${versionId}"` };
      // A fact that fails at 0% is only evidence against the new version if the old version behaves differently.
      const pinnedFails = await this.factsOn(seq, url, pin, "gate");
      const broke: typeof pinnedFails = [];
      for (const b of pinnedFails) {
        const old = await runCheck(b.fact.check as ProbeCheck, url, `gate:${b.fact.id}`);
        if (old.held || old.detail !== b.detail) broke.push(b);
      }
      const facts = this.rows(`SELECT id FROM facts WHERE status = 'canon'`);
      if (broke.length) {
        const what = `broke “${broke[0].fact.sentence}” on production in its smoke test: ${broke[0].detail}`;
        this.sql.exec(`UPDATE canon SET health = 'held', health_detail = ? WHERE seq = ?`, `${what}. Held back: production never served it.`, seq);
        this.broadcast();
        // Take the staged version back out of production's deployment as it is now, not as it was before the test.
        const now = await liveNow();
        const keep = now.filter((v) => v.version_id !== versionId).sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
        if (keep) await write([{ version_id: keep, percentage: 100 }], `Canon #${seq} held back: broke ${broke[0].fact.id} at 0%`);
        return { released: false, detail: what };
      }
      // The gradual rollout: a share of real traffic at each step, watched before the next.
      const plan = this.canaryPlan();
      const exposure: NonNullable<Acceptance["exposure"]> = [];
      for (const percent of plan.steps) {
        await write([{ version_id: versionId, percentage: percent }, { version_id: current, percentage: 100 - percent }], `Canon #${seq}: ${percent}% of traffic`);
        const watched = await this.canaryWatch(seq, url, project, versionId, current, plan.holdSeconds);
        exposure.push({ percent, ...watched, at: Date.now() });
        this.recordExposure(seq, exposure);
        if (watched.bad) {
          const what = `broke at ${percent}% of production traffic: ${watched.verdict}`;
          this.sql.exec(`UPDATE canon SET health = 'held', health_detail = ? WHERE seq = ?`, `${what}. Taken back out of production.`, seq);
          this.broadcast();
          const now = await liveNow();
          const keep = now.filter((v) => v.version_id !== versionId).sort((a, b) => b.percentage - a.percentage)[0]?.version_id ?? current;
          await write([{ version_id: keep, percentage: 100 }], `Canon #${seq} held back at ${percent}%`);
          return { released: false, detail: what };
        }
      }
      await write([{ version_id: versionId, percentage: 100 }], `Canon #${seq}: released, ${facts.length} facts held at 0%${plan.steps.length ? `, then ${plan.steps.join("%, ")}%` : ""}`);
      return { released: true, detail: `${facts.length} facts held on the staged version${plan.steps.length ? `; rolled out at ${plan.steps.join("%, ")}%` : ""}` };
    } catch (err) {
      if (err instanceof Fenced) return { released: false, detail: FENCED };
      throw err;
    }
  }

  /** Where production answers: canon.json's "production", or the deployment's template for the project. */
  private productionUrl(): string {
    return this.meta("productionUrl") ?? this.env.PRODUCTION_URL.replace("{project}", this.requireProject());
  }

  /** The rollout plan from the project's policy (canon.json "canary"), with its defaults. */
  private canaryPlan(): { steps: number[]; holdSeconds: number } {
    const p = JSON.parse(this.meta("canary") ?? "null") as { steps?: number[]; holdSeconds?: number } | false | null;
    if (p === false) return { steps: [], holdSeconds: 0 };
    const steps = (p?.steps ?? [10, 50]).filter((n) => Number.isFinite(n) && n > 0 && n < 100).sort((a, b) => a - b);
    return { steps, holdSeconds: Math.min(300, Math.max(10, p?.holdSeconds ?? 45)) };
  }

  /**
   * Watches one rollout step. For holdSeconds, every canon probe fact runs three ways at the same moment with the same
   * inputs: pinned to the new version, pinned to the old one, and routed as real traffic is. A failure counts against
   * the new version only when the old one passed the same check at the same moment, so a flaky network or a shared
   * dependency doesn't. Then real traffic per version from analytics, when the account allows it.
   */
  private async canaryWatch(seq: number, url: string, project: string, versionId: string, oldId: string, holdSeconds: number) {
    const pin = (v: string) => ({ "cloudflare-workers-version-overrides": `${project}="${v}"` });
    const facts = this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact).filter((f) => f.check.kind === "probe");
    // The facts this release lands fail on the old version by definition: they are judged on the new version alone.
    const landing = new Set(this.acceptance(seq)?.facts.map((f) => f.id) ?? []);
    const since = new Date(Date.now() - 5_000).toISOString();
    const start = Date.now();
    const rounds = 10;
    let newFails = 0, oldFails = 0, routedFails = 0, mixedFails = 0, checks = 0;
    for (let round = 0; round < rounds; round++) {
      for (const f of facts) {
        const seed = `canary:${seq}:${round}:${f.id}`;
        const [onNew, onOld, routed] = await Promise.all([
          runCheck(f.check as ProbeCheck, url, seed, pin(versionId)),
          landing.has(f.id) ? Promise.resolve({ held: true, detail: "ok", ms: 0 }) : runCheck(f.check as ProbeCheck, url, seed, pin(oldId)),
          runCheck(f.check as ProbeCheck, url, seed),
        ]);
        checks++;
        if (!onOld.held) oldFails++;
        else {
          if (!onNew.held) newFails++;
          // Routed traffic lands on either version: a landing fact can fail on the old one, which says nothing. An
          // existing fact failing routed while both pinned versions pass it is a mixed-version failure.
          if (!routed.held && !landing.has(f.id)) {
            routedFails++;
            if (onNew.held) mixedFails++;
          }
        }
      }
      // Spread the rounds over the hold, so the step is watched for its whole length (and real traffic has time to show).
      const due = start + ((round + 1) * holdSeconds * 1000) / rounds;
      if (Date.now() < due) await new Promise((r) => setTimeout(r, due - Date.now()));
    }
    // Raw requests, no retries, to both versions at once: every GET step of every fact, until 40 each.
    const gets = facts.flatMap((f) => (f.check as ProbeCheck).steps.filter((st) => (st.method ?? "GET") === "GET" && !st.path.includes("{{")).map((st) => st.path));
    let newErrors = 0, oldErrors = 0, each = 0;
    for (let i = 0; gets.length && i < 40; i++) {
      const path = gets[i % gets.length];
      const hit = async (v: string) => {
        try {
          const res = await fetch(new URL(path, url), { headers: pin(v), signal: AbortSignal.timeout(10_000) });
          await res.arrayBuffer();
          return res.status >= 500;
        } catch {
          return true;
        }
      };
      const [n, o] = await Promise.all([hit(versionId), hit(oldId)]);
      each++;
      if (n) newErrors++;
      if (o) oldErrors++;
    }
    let analytics = "unavailable";
    let rates: { newRate: number; oldRate: number; newRequests: number } | undefined;
    const t = await versionTraffic(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CF_TOKEN, project, since);
    if (t.ok) {
      const n = t.traffic[versionId] ?? { requests: 0, errors: 0 };
      const o = t.traffic[oldId] ?? { requests: 0, errors: 0 };
      rates = { newRate: n.requests ? n.errors / n.requests : 0, oldRate: o.requests ? o.errors / o.requests : 0, newRequests: n.requests };
      analytics = `real traffic so far (analytics lag a minute or two): new ${n.errors}/${n.requests} errors, old ${o.errors}/${o.requests}`;
    } else analytics = `real-traffic analytics unavailable (${t.why})`;
    const v = canaryVerdict({ newFails, oldFails, mixedFails, raw: { newErrors, oldErrors, each }, ...(rates ? { analytics: rates } : {}) });
    return { newFails, oldFails, routedFails, mixedFails, checks, raw: `${newErrors}/${each} raw errors on the new version, ${oldErrors}/${each} on the old`, analytics, verdict: v.why, bad: v.bad };
  }

  private recordExposure(seq: number, exposure: NonNullable<Acceptance["exposure"]>) {
    const record = this.acceptance(seq);
    if (record) this.sql.exec(`UPDATE acceptances SET json = ? WHERE seq = ?`, JSON.stringify({ ...record, exposure: exposure.map(({ ...e }) => { delete (e as { bad?: boolean }).bad; return e; }) }), seq);
  }

  /**
   * The judge's reconciliation of production, the one place a deployment is corrected outside a release: when no
   * release holds the lease, production's deployment must be canon's released version at 100%. Anything else (a 0%
   * version a fenced-out run left staged, a deploy that slipped in from a stale run) is put back, from the deployment as
   * it is now. At most once every five minutes.
   */
  private async reconcileProduction() {
    if (this.productionOwner() !== null) return;
    const last = Number(this.meta("reconciledAt") ?? 0);
    if (Date.now() - last < 5 * 60_000) return;
    this.setMeta("reconciledAt", String(Date.now()));
    // Only when canon is released and its version is known (genesis deploys outside Canon have none).
    const released = this.currentCanon();
    if (!released || Number(released.deployed) !== 1 || !released.version_id) return;
    const project = this.requireProject();
    const api = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${project}/deployments`;
    const live = (await (await fetch(api, { headers: { authorization: `Bearer ${this.env.CF_TOKEN}` } })).json<{ result?: { deployments?: Array<{ versions: Array<{ version_id: string; percentage: number }> }> } }>()).result?.deployments?.[0]?.versions;
    if (!live?.length) return;
    if (live.length === 1 && live[0].version_id === released.version_id && live[0].percentage === 100) return;
    await this.restoreProduction(`production's deployment wasn't canon #${released.seq}'s version alone (${live.map((v) => `${v.version_id.slice(0, 8)} ${v.percentage}%`).join(", ")})`);
  }

  /** Puts production on the version the current canon was released as (after a fenced-out run changed it). */
  private async restoreProduction(why: string) {
    const project = this.requireProject();
    const cur = this.rows(`SELECT * FROM canon WHERE deployed = 1 AND version_id IS NOT NULL ORDER BY seq DESC LIMIT 1`)[0];
    if (!cur) return;
    const api = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${project}/deployments`;
    // Authority is rechecked inside judgeWrite, after any wait and in the same turn as the request: a release or
    // republish that took the lease meanwhile owns production now, and this backs off (reconciliation runs again).
    if (this.productionOwner() !== null) return;
    const res = await this.judgeWrite(api, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.CF_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ strategy: "percentage", versions: [{ percentage: 100, version_id: cur.version_id }], annotations: { "workers/message": `Canon: back to canon #${cur.seq}: ${why}`.slice(0, 100) } }),
    }, () => this.productionOwner());
    if (!res) return;
    if (!res.ok) throw new Error(`deployments API returned ${res.status}`);
    this.sql.exec(`UPDATE canon SET health_detail = ? WHERE seq = ?`, `production restored to this canon: ${why}`, cur.seq);
  }

  /**
   * Puts production back on the last healthy version (Workers deployments: the same version at 100%). The canon
   * itself does not move: the fact was accepted, the deploy just didn't hold in production, and the board says so.
   */
  private async rollBack(live: Row, what: string) {
    const project = this.requireProject();
    const healthy = this.rows(`SELECT * FROM canon WHERE seq < ? AND health = 'healthy' AND version_id IS NOT NULL ORDER BY seq DESC LIMIT 1`, live.seq)[0];
    const api = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${project}/deployments`;
    const headers = { authorization: `Bearer ${this.env.CF_TOKEN}`, "content-type": "application/json" };
    try {
      let version = (healthy?.version_id as string | undefined) ?? null;
      // No healthy canon recorded a version yet (genesis deploys outside Canon): take the deployment before this one.
      if (!version) {
        const list = await (await fetch(api, { headers })).json<{ result?: { deployments?: Array<{ versions: Array<{ version_id: string }> }> } }>();
        version = list.result?.deployments?.find((d) => d.versions[0]?.version_id !== live.version_id)?.versions[0]?.version_id ?? null;
      }
      if (!version) throw new Error("no earlier version to roll back to");
      // Same rule as every other production write: not while a release holds the lease (rechecked in judgeWrite, after
      // any wait and in the same turn as the request).
      const res = await this.judgeWrite(api, {
        method: "POST",
        headers,
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: version }],
          annotations: { "workers/message": `Canon rolled back: canon #${live.seq} ${what}`.slice(0, 100) },
        }),
      }, () => this.productionOwner());
      if (!res) throw new Error(`${this.productionOwner() ?? "a release"} owns production's deployment; it decides what production runs`);
      if (!res.ok) throw new Error(`deployments API returned ${res.status}`);
      const to = healthy ? `canon #${healthy.seq}` : "the version before it";
      this.sql.exec(`UPDATE canon SET health = 'rolled-back', health_detail = ? WHERE seq = ?`, `${what}. Production rolled back to ${to}.`, live.seq);
      // Production went back, so canon goes back with it.
      await this.revertCanon(live.seq as number, `${what}. Production rolled back to ${to}.`);
      // Check the restored version shortly.
      await this.scheduleProductionCheck(20_000);
    } catch (err) {
      this.sql.exec(`UPDATE canon SET health_detail = ? WHERE seq = ?`, `${what}. Couldn't roll back: ${String(err).slice(0, 120)}`, live.seq);
    }
  }

  // The production check shares the one alarm with re-judging; never move an earlier alarm later.
  private async scheduleProductionCheck(inMs: number) {
    const at = Date.now() + inMs;
    this.setMeta("prodCheckAt", String(at));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- Why: the fact chain -----------------------------------------------------------

  why(factId: string) {
    const raw = this.fact(factId);
    if (!raw) throw new ProtocolError(404, "no such fact");
    const fact = this.redactFact(raw);
    // A fact's history is the attempts that tried to make it true, plus the attempts that broke it
    // while it was canon. Each trial links the Preview of the exact commit judged, not the
    // attempt's latest one, so a rejected attempt stays viewable as it was.
    const canonSince = fact.acceptedAt ?? Number.MAX_SAFE_INTEGER;
    const canonUntil = fact.retiredAt ?? Number.MAX_SAFE_INTEGER;
    const trials = this.rows(
      `SELECT r.attempt_id, r.sha, r.held, r.detail, r.at,
              COALESCE(NULLIF(json_extract(v.json, '$.previewUrl'), ''), w.preview_url) AS preview_url,
              c.agent, c.why, c.status, c.fact_id AS claimed_fact, w.created_at AS forked_at,
              f.replaces AS claim_replaces
         FROM results r
         JOIN attempts w ON w.id = r.attempt_id
         LEFT JOIN claims c ON c.id = w.claim_id
         LEFT JOIN facts f ON f.id = c.fact_id
         LEFT JOIN verdicts v ON v.attempt_id = r.attempt_id AND v.sha = r.sha
        WHERE r.fact_id = ? AND (c.fact_id = ? OR (r.at >= ? AND r.at <= ?))
        ORDER BY r.at DESC`,
      factId, factId, canonSince, canonUntil,
    );
    // Each failed trial is an attempt (the attempt claimed this fact), a revision (the attempt replaces
    // it on purpose), a contradiction (forked after the fact was canon and still broke it), or behind
    // (built before the fact existed, so it simply lacks the code).
    const kindOf = (t: Row) =>
      t.claimed_fact === factId ? "attempt"
        : t.claim_replaces === factId ? "revision"
          : (t.forked_at as number) >= canonSince ? "contradiction" : "behind";
    const claimFor = (attemptId: string | null) => (attemptId ? (this.rows(`SELECT * FROM claims WHERE attempt_id = ?`, attemptId).map(toClaim)[0] ?? null) : null);
    const madeTrueBy = fact.madeTrueBy ? { attempt: this.attempt(fact.madeTrueBy), claim: claimFor(fact.madeTrueBy) } : null;
    const replacement = this.rows(`SELECT * FROM facts WHERE replaces = ? AND status = 'canon'`, factId).map(toFact)[0] ?? null;
    const retiredBy = fact.retiredBy ? { attempt: this.attempt(fact.retiredBy), claim: claimFor(fact.retiredBy), replacement } : null;
    // proposedBy holds the id of the claim that first proposed the fact.
    const proposer = fact.proposedBy ? (this.rows(`SELECT * FROM claims WHERE id = ?`, fact.proposedBy).map(toClaim)[0] ?? null) : null;
    return {
      fact,
      proposer,
      madeTrueBy,
      retiredBy,
      replaces: fact.replaces ? this.fact(fact.replaces) : null,
      rejected: trials.filter((t) => !t.held).map((t) => ({ ...t, kind: kindOf(t), ...(raw.origin === "heldout" ? { detail: HELD_OUT_DETAIL } : {}) })),
      held: trials.filter((t) => t.held),
    };
  }

  /**
   * Runs a fact's check against production right now, so anyone can watch it hold (or, for a proposed
   * fact, see that it doesn't yet). Probes carry their own run id, so production data is untouched.
   * Command facts need a checkout and run in CI. Results are cached briefly per fact.
   */
  async checkProduction(factId: string) {
    const fact = this.fact(factId);
    if (!fact) throw new ProtocolError(404, "no such fact");
    if (fact.check.kind !== "probe") throw new ProtocolError(400, "command facts run in CI on every push, not against production");
    const cached = this.liveChecks.get(factId);
    if (cached && Date.now() - cached.at < LIVE_CHECK_TTL_MS) return cached;
    const url = this.productionUrl();
    const ran = await runCheck(fact.check, url);
    // A held-out fact says whether it holds, never how it's checked or what failed.
    const result = { ...ran, ...(fact.origin === "heldout" && !ran.held ? { detail: HELD_OUT_DETAIL } : {}), url, at: Date.now() };
    this.liveChecks.set(factId, result);
    return result;
  }

  // ---- Board -------------------------------------------------------------------------

  async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify(this.read()));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage() {}

  private broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const state = JSON.stringify(this.read());
    for (const ws of sockets) {
      try {
        ws.send(state);
      } catch {
        // closed socket; the runtime drops it
      }
    }
  }

  // ---- After a verdict: clashes and refreshes ------------------------------------------

  /** A Ready claim is checked against the other Ready claims; a claim that fell behind is refreshed by the judge. */
  private async followUp(claimId: string | null, verdict: Verdict) {
    if (!claimId) return;
    try {
      if (verdict.outcome === "ready" || verdict.outcome === "unproven") await this.findClashes(claimId);
      if (verdict.outcome === "ready") await this.startMutation(claimId, verdict);
      // The reviewer reads the change after its checks are tested (it can point at code no fact covers); a change
      // whose checks aren't tested gets reviewed now.
      if (verdict.outcome === "ready" && !this.rows(`SELECT 1 FROM mutations WHERE attempt_id = ? AND sha = ?`, this.claim(claimId)?.attemptId ?? "", verdict.sha).length) this.ctx.waitUntil(this.startReview(claimId, verdict).catch(() => {}));
      if (verdict.outcome === "behind") await this.autoRefresh(claimId);
    } catch {
      // Best effort: the verdict stands either way.
    }
    this.broadcast();
  }

  /**
   * Did an attempt build the very behaviour a fact tests, the other way? `there` is the fact's result on the attempt;
   * the same check, with the same inputs, runs on the canon the attempt forked from. Failing at the same step only
   * means the attempt lacks that code. Getting further and then failing means it changed that behaviour differently.
   */
  private async interferes(fact: Fact, there: CheckResult, forkedFrom: string, seed: string): Promise<string | null> {
    if (fact.check.kind !== "probe" || there.held) return null;
    const before = await runCheck(fact.check, forkedFrom, seed);
    // A platform hiccup on the old Preview proves nothing.
    if (before.held || /failed:|returned 5\d\d/.test(before.detail)) return null;
    if (progress(there.detail) <= progress(before.detail)) return null;
    return `${there.detail} (on the canon it forked from, the check stopped earlier: ${before.detail})`;
  }

  /**
   * Two Ready claims can each keep canon and still be impossible together. Before anyone accepts either, each one's
   * fact runs on the other's preview: if the other attempt built that behaviour the other way, they clash. Accepting
   * one re-applies the other on the new canon, and the combined code decides: it is rejected only if it still breaks
   * the accepted fact. A plain text conflict is not a clash; the judge's refresh handles those.
   */
  private async findClashes(claimId: string) {
    const claim = this.claim(claimId);
    if (claim?.status !== "ready" && claim?.status !== "unproven") return;
    const mine = this.attempt(claim.attemptId);
    // Ready attempts and ones still being written (unproven: canon holds, their own fact not yet). Two Ready ones that
    // collide are a clash; while either is still unproven the same finding is a heads-up to both agents.
    const others = this.rows(`SELECT * FROM claims WHERE status IN ('ready', 'unproven') AND id != ? AND fact_id != ?`, claim.id, claim.factId).map(toClaim);
    const found: Array<{ claimId: string; otherId: string; factId: string; detail: string }> = [];
    const probe = async (owner: Claim, on: Attempt | null, otherId: string) => {
      const fact = this.fact(owner.factId);
      const forkedFrom = on?.baseAttempt ? this.attempt(on.baseAttempt)?.previewUrl : null;
      const judgedOn = on ? this.judgedPreview(on) : null;
      if (fact?.check.kind !== "probe" || !judgedOn || !forkedFrom) return;
      const seed = `${judgedOn.sha}:${crypto.randomUUID().slice(0, 8)}:${fact.id}`; // fresh, the same on both previews
      const detail = await this.interferes(fact, await runCheck(fact.check, judgedOn.previewUrl, seed), forkedFrom, seed);
      if (detail) found.push({ claimId: owner.id, otherId, factId: fact.id, detail });
    };
    await Promise.all(others.flatMap((other) => [probe(claim, this.attempt(other.attemptId), other.id), probe(other, mine, claim.id)]));
    this.sql.exec(`DELETE FROM clashes WHERE claim_id = ? OR other_claim_id = ?`, claim.id, claim.id);
    for (const f of found) {
      this.sql.exec(`INSERT OR REPLACE INTO clashes (claim_id, other_claim_id, fact_id, detail, at) VALUES (?, ?, ?, ?, ?)`, f.claimId, f.otherId, f.factId, f.detail, Date.now());
    }
  }

  /** The clashes between this claim and other claims, while both are Ready. */
  private clashesFor(claimId: string): Clash[] {
    if (this.claim(claimId)?.status !== "ready") return [];
    return this.rows(`SELECT * FROM clashes WHERE claim_id = ? OR other_claim_id = ?`, claimId, claimId).flatMap((r) => {
      const mine = r.claim_id === claimId;
      const other = this.claim((mine ? r.other_claim_id : r.claim_id) as string);
      if (other?.status !== "ready") return [];
      return [{ with: { claimId: other.id, agent: other.agent, attemptId: other.attemptId, factId: other.factId }, factId: r.fact_id as string, breaks: mine ? "mine" : "theirs", detail: r.detail as string } satisfies Clash];
    });
  }

  /**
   * Before a push: who else is changing the files I'm changing? The judge adds what this attempt already pushed (from
   * the two Git trees in Artifacts) to the paths the agent has changed locally, and lists every other attempt in
   * flight that changed any of them, with the fact it is building. Overlapping files are often fine (behaviour decides,
   * not text); this is so agents can talk before either finds out from a verdict.
   */
  async overlaps(attemptId: string, localPaths: string[], localFiles: Record<string, string> = {}) {
    const mine = this.attempt(attemptId);
    if (!mine?.claimId) throw new ProtocolError(404, `no attempt ${attemptId}`);
    const pushed = mine.headSha ? ((await this.changedPaths(mine, mine.headSha)) ?? []) : [];
    const paths = new Set([...pushed, ...localPaths.slice(0, 500)].filter((p) => typeof p === "string" && p && p !== "canon.json"));
    // Which functions I'm changing: my working copy (or my last push) against the canon my attempt forked from.
    const code = /\.(ts|tsx|js|jsx|mjs)$/;
    const mineSyms = new Map<string, Set<string>>();
    const myAdded: string[] = [];
    for (const path of [...paths].filter((p) => code.test(p)).slice(0, 20)) {
      const head = typeof localFiles[path] === "string" ? localFiles[path].slice(0, 400_000) : mine.headSha ? await this.fileAt(mine.id, mine.headSha, path) : null;
      const base = mine.baseSha ? await this.fileAt(mine.id, mine.baseSha, path) : null;
      if (head === null) continue;
      mineSyms.set(path, new Set(changedSymbols(base ?? "", head)));
      myAdded.push(...addedText(base ?? "", head));
    }
    const mySymsAll = [...new Set([...mineSyms.values()].flatMap((s) => [...s]))];
    const out: Array<{ claimId: string; agent: string; factId: string; sentence: string; status: ClaimStatus; attemptId: string; files: string[]; symbols: string[]; youCall: string[]; theyCall: string[] }> = [];
    for (const c of this.rows(`SELECT * FROM claims WHERE status IN ('open', 'checking', 'unproven', 'ready', 'behind') AND attempt_id != ?`, attemptId).map(toClaim)) {
      const a = this.attempt(c.attemptId);
      if (!a?.headSha) continue;
      const theirPaths = (await this.changedPaths(a, a.headSha)) ?? [];
      const files = theirPaths.filter((p) => paths.has(p));
      const symbols: string[] = [];
      for (const path of files.filter((p) => mineSyms.has(p))) {
        for (const s of await this.symbolsOf(a, path)) if (mineSyms.get(path)!.has(s)) symbols.push(`${s} in ${path}`);
      }
      // Calls across the two changes, in any file: you start calling what they change, or they call what you change.
      const theirCode = theirPaths.filter((p) => code.test(p)).slice(0, 20);
      const theirSyms: string[] = [];
      const theirAdded: string[] = [];
      for (const path of theirCode) {
        theirSyms.push(...(await this.symbolsOf(a, path)));
        theirAdded.push(...(await this.addedOf(a, path)));
      }
      const youCall = callsInto(myAdded, theirSyms).filter((s) => !mySymsAll.includes(s));
      const theyCall = callsInto(theirAdded, mySymsAll).filter((s) => !theirSyms.includes(s));
      if (!files.length && !youCall.length && !theyCall.length) continue;
      out.push({ claimId: c.id, agent: c.agent, factId: c.factId, sentence: this.fact(c.factId)?.sentence ?? c.factId, status: c.status, attemptId: c.attemptId, files, symbols, youCall, theyCall });
    }
    const weight = (x: { symbols: string[]; youCall: string[]; theyCall: string[] }) => x.symbols.length + x.youCall.length + x.theyCall.length;
    out.sort((x, y) => weight(y) - weight(x));
    return { paths: [...paths], overlaps: out, headsUp: this.headsUpFor(mine.claimId), clashes: this.clashesFor(mine.claimId) };
  }

  /** A file's text at a commit of an attempt, or null if it isn't there. */
  private async fileAt(repoName: string, ref: string, path: string): Promise<string | null> {
    try {
      using repo = await this.env.ARTIFACTS.get(repoName);
      const blob = await repo.readFile({ ref, path });
      return blob ? await blob.text() : null;
    } catch {
      return null;
    }
  }

  /** The lines an attempt's pushed commit adds to a file (cached per commit). */
  private async addedOf(a: Attempt, path: string): Promise<string[]> {
    const key = `add:${a.id}:${a.headSha}:${path}`;
    if (this.changedCache.has(key)) return this.changedCache.get(key) ?? [];
    const head = a.headSha ? await this.fileAt(a.id, a.headSha, path) : null;
    const base = a.baseSha ? await this.fileAt(a.id, a.baseSha, path) : null;
    const lines = head === null ? [] : addedText(base ?? "", head);
    this.changedCache.set(key, lines);
    return lines;
  }

  /** The functions an attempt's pushed commit changes in a file, against the canon it forked from (cached per commit). */
  private async symbolsOf(a: Attempt, path: string): Promise<string[]> {
    const key = `sym:${a.id}:${a.headSha}:${path}`;
    if (this.changedCache.has(key)) return this.changedCache.get(key) ?? [];
    const head = a.headSha ? await this.fileAt(a.id, a.headSha, path) : null;
    const base = a.baseSha ? await this.fileAt(a.id, a.baseSha, path) : null;
    const syms = head === null ? [] : changedSymbols(base ?? "", head);
    this.changedCache.set(key, syms);
    return syms;
  }

  /** The same findings while either side is still being written: a heads-up to both agents, not a clash yet. */
  private headsUpFor(claimId: string): Clash[] {
    const me = this.claim(claimId);
    if (me?.status !== "ready" && me?.status !== "unproven") return [];
    return this.rows(`SELECT * FROM clashes WHERE claim_id = ? OR other_claim_id = ?`, claimId, claimId).flatMap((r) => {
      const mine = r.claim_id === claimId;
      const other = this.claim((mine ? r.other_claim_id : r.claim_id) as string);
      if (!other || (other.status !== "ready" && other.status !== "unproven")) return [];
      if (me.status === "ready" && other.status === "ready") return []; // that's a clash
      return [{ with: { claimId: other.id, agent: other.agent, attemptId: other.attemptId, factId: other.factId }, factId: r.fact_id as string, breaks: mine ? "mine" : "theirs", detail: r.detail as string } satisfies Clash];
    });
  }

  /**
   * An attempt that is behind only lacks code canon gained after it forked. The judge re-applies its change on the
   * current canon as a new attempt (the same move as `canon refresh`) and pushes it, so the agent does nothing.
   * Only a text conflict goes back to the agent.
   */
  private async autoRefresh(claimId: string) {
    const claim = this.claim(claimId);
    const old = claim ? this.attempt(claim.attemptId) : null;
    // A refresh under way or handed back blocks another; a repaired one is done (its attempt can fall behind again).
    if (claim?.status !== "behind" || (claim.refresh && claim.refresh !== "repaired") || !old?.headSha || !old.baseSha) return;
    this.sql.exec(`UPDATE claims SET refresh = 'started' WHERE id = ?`, claim.id);
    let fresh: Declared | null = null;
    try {
      const canon = this.currentCanon()!;
      const why = `${claim.why.replace(/ \(refreshed onto canon \d+\)$/, "")} (refreshed onto canon ${canon.seq})`;
      fresh = await this.declare({ agent: claim.agent, why, join: claim.factId, replaces: claim.id, ...(claim.touches ? { touches: claim.touches } : {}), ...(claim.after ? { after: claim.after } : {}) });
      this.sql.exec(`UPDATE claims SET refreshed_from = ? WHERE id = ?`, claim.id, fresh.claim.id);
      // Re-applied, it is still the same rider: it keeps its place in a failed train's halves (and out of other trains).
      const failed = JSON.parse(this.meta("trainFailed") ?? "[]") as string[];
      if (failed.includes(claim.id)) this.setMeta("trainFailed", JSON.stringify([...failed, fresh.claim.id].slice(-200)));
      const halves = JSON.parse(this.meta("bisect") ?? "[]") as string[][];
      const freshId = fresh.claim.id;
      if (halves.some((g) => g.includes(claim.id))) this.setMeta("bisect", JSON.stringify(halves.map((g) => g.map((id) => (id === claim.id ? freshId : id)))));
      await this.env.REFRESH_WORKFLOW.create({ id: `refresh-${fresh.attempt.id}`, params: this.ciParams(fresh.attempt.id, canon.sha as string) });
    } catch (err) {
      if (fresh) await this.refreshed(fresh.attempt.id, "failed", String(err));
      else this.sql.exec(`UPDATE claims SET refresh = 'failed' WHERE id = ?`, claim.id);
    }
  }

  /**
   * The fact chain, written into Git: one note per canon commit (refs/notes/canon) saying which fact it made canon,
   * who made it true and how it was checked, who accepted it and why, and every attempt that broke it. All of them are
   * regenerated on each promotion (earlier facts gain their later history) and pushed to the canon attempt, so
   * `git clone https://canon.rodeo/p/<project>.git` then `git log --notes=canon` reads the history with no Canon tools.
   */
  async noteJob(seq: number): Promise<Record<string, string> | null> {
    const row = this.rows(`SELECT * FROM canon WHERE seq = ?`, seq)[0];
    const target = row ? this.attempt(row.attempt_id as string) : null;
    if (!row || !target) return null;
    const origin = "https://canon.rodeo";
    const iso = (t: unknown) => new Date(Number(t)).toISOString().replace(/\.\d+Z$/, "Z");
    const short = (s: unknown) => String(s ?? "").slice(0, 7);
    const howChecked = (f: Fact) =>
      f.check.kind === "command" ? [`  $ ${f.check.run}`]
        : f.check.steps.map((s) => `  ${s.method ?? "GET"} ${s.path}${s.body ? ` ${JSON.stringify(s.body)}` : ""}${s.expect?.status ? ` -> ${s.expect.status}` : ""}`);
    const notes: Array<{ sha: string; text: string }> = [];
    for (const c of this.rows(`SELECT * FROM canon WHERE seq <= ? ORDER BY seq`, seq)) {
      const lines: string[] = [];
      if (c.reverts) {
        const was = this.rows(`SELECT * FROM canon WHERE seq = ?`, c.reverts)[0];
        lines.push(`Canon #${c.seq}: back to the code of canon #${this.rows(`SELECT seq FROM canon WHERE attempt_id = ? AND reverts IS NULL ORDER BY seq LIMIT 1`, c.attempt_id)[0]?.seq ?? "?"}, reverting canon #${c.reverts}`, "");
        lines.push(`why: canon #${c.reverts} ("${this.fact(String(was?.accepted_fact ?? ""))?.sentence ?? was?.accepted_fact}") was not released: ${was?.health_detail ?? "it couldn't deploy"}`);
        lines.push("Canon is what production runs, so the fact is proposed again.");
      } else if (c.facts_json && (JSON.parse(c.facts_json as string) as string[]).length > 1) {
        const ids = JSON.parse(c.facts_json as string) as string[];
        lines.push(`Canon #${c.seq}: a merge train of ${ids.length} facts, checked as one candidate and released once`, "");
        for (const id of ids) {
          const w = this.why(id);
          const by = w.madeTrueBy?.claim;
          lines.push(`- ${w.fact.sentence} (${id})`);
          if (by) lines.push(`  made true by ${by.agent} in ${w.madeTrueBy?.attempt?.id}; why: "${by.why}"`);
          lines.push(`  accepted: by ${w.fact.acceptedHow ?? "the charter"}`, ...howChecked(w.fact).map((l) => `  ${l}`));
        }
        lines.push("", `train attempt: ${c.attempt_id} @ ${short(c.sha)}`);
      } else if (!c.accepted_fact) {
        const seeds = this.rows(`SELECT * FROM facts WHERE origin = 'seed'`).map(toFact);
        lines.push(`Canon #${c.seq}: genesis, the seed facts from canon.json`, "");
        for (const f of seeds) lines.push(`- ${f.sentence} (${f.id})`);
      } else {
        const w = this.why(c.accepted_fact as string);
        const f = w.fact;
        const by = w.madeTrueBy?.claim;
        const v = this.latestVerdict(c.attempt_id as string);
        lines.push(`Canon #${c.seq}: ${f.sentence}`, "", `fact: ${f.id}`);
        if (w.replaces) lines.push(`replaces: "${w.replaces.sentence}" (${w.replaces.id}), on purpose`);
        lines.push(`accepted: by ${f.acceptedHow ?? "the owner"}, ${iso(c.at)}`);
        if (by) lines.push(`made true by: ${by.agent}, attempt ${c.attempt_id} @ ${short(c.sha)}`);
        if (w.proposer) lines.push(`why: "${w.proposer.why}" (${w.proposer.agent})`);
        if (v) lines.push(`verdict: kept ${v.kept.length} canon facts and made its own true${v.seed ? ` (inputs from seed ${v.seed})` : ""}`);
        if (v?.previewUrl) lines.push(`preview: ${v.previewUrl}`);
        lines.push("check:", ...howChecked(f));
        const trial = (t: Row) => `- ${t.agent ?? "?"}, ${t.attempt_id} @ ${short(t.sha)}: ${String(t.detail).slice(0, 220)}`;
        const rejected = w.rejected as Row[];
        const broke = rejected.filter((t) => t.kind !== "behind");
        const before = rejected.filter((t) => t.kind === "behind");
        const clashed = this.rows(`SELECT DISTINCT c.agent, c.fact_id FROM clashes k JOIN claims c ON c.id = k.other_claim_id WHERE k.fact_id = ?`, f.id);
        for (const k of clashed) lines.push(`clashed with: ${k.agent}'s "${this.fact(k.fact_id as string)?.sentence ?? k.fact_id}" (${k.fact_id}), flagged before anyone accepted`);
        if (broke.length) lines.push("", `broke it, and were rejected or sent back (${broke.length}):`, ...broke.map(trial));
        if (before.length) lines.push("", `built before it existed, then re-applied by the judge (${before.length}):`, ...before.map(trial));
        if (f.retiredAt) lines.push("", `retired: ${iso(f.retiredAt)}, replaced on purpose by attempt ${f.retiredBy}`);
      }
      const record = this.acceptance(c.seq as number);
      if (record) {
        lines.push("", `acceptance record (${origin}/p/${this.requireProject()}/canon/${c.seq}/acceptance):`);
        lines.push(`  authorized: ${short(record.sha)} on canon #${record.judgedOnCanon}, by ${record.authorizedBy.slice(0, 200)}`);
        lines.push(`  policy: ${record.policy.version} (autoAccept ${record.policy.autoAccept})`);
        for (const f of record.facts) {
          const e = f.evidence;
          lines.push(`  ${f.id}: mutation ${e.mutation.state}, review ${e.review.state}, data ${e.data.state}${e.scope ? `, scope ${e.scope.state}` : ""}`);
        }
        if (record.exceptions.length) lines.push(`  exceptions (accepted by a person): ${record.exceptions.join("; ").slice(0, 300)}`);
        lines.push(`  recovery: ${record.recovery.how}`);
        if (record.recovery.rehearsal) lines.push(`  rollback rehearsal: ${record.recovery.rehearsal.state}: ${record.recovery.rehearsal.detail.slice(0, 200)}`);
        for (const a of record.alternatives ?? []) lines.push(`  alternative: ${a.agent}, ${a.attemptId}: ${a.outcome}`);
        for (const e of record.exposure ?? []) lines.push(`  rollout ${e.percent}%: ${e.verdict}; ${e.checks} paired checks (new failed ${e.newFails}, old ${e.oldFails}); ${e.analytics}`);
        if (record.chosenBecause) lines.push(`  chosen because: ${record.chosenBecause.slice(0, 300)}`);
      }
      lines.push("", `Every attempt stays clonable: git clone ${origin}/a/<attempt>.git`, `Canon-Seq: ${c.seq}`, ...(c.accepted_fact ? [`Canon-Fact: ${c.accepted_fact}`] : []));
      notes.push({ sha: c.sha as string, text: lines.join("\n") + "\n" });
    }
    const prev = this.rows(`SELECT attempt_id FROM canon WHERE seq < ? AND attempt_id != ? ORDER BY seq DESC LIMIT 1`, seq, row.attempt_id)[0];
    const prevAttempt = prev ? this.attempt(prev.attempt_id as string) : null;
    return {
      CANON_URL: await this.tokenUrl(target, "write"),
      PREV_URL: prevAttempt ? await this.tokenUrl(prevAttempt, "read") : "",
      NOTES: base64(new TextEncoder().encode(JSON.stringify(notes))),
    };
  }

  private async tokenUrl(a: Attempt, scope: "read" | "write") {
    using repo = await this.env.ARTIFACTS.get(a.id);
    const token = await repo.createToken(scope, 30 * 60);
    const u = new URL(a.remote);
    u.username = "x";
    u.password = token.plaintext;
    return u.toString();
  }

  /** The repo production runs: the current canon's attempt (for the stable clone URL /p/<project>.git). */
  canonRepo(): string | null {
    return (this.currentCanon()?.attempt_id as string | undefined) ?? null;
  }

  /** Re-runs the current canon's promotion (the same commit redeploys), which rewrites the Git notes. Owner only. */
  async republish() {
    const canon = this.currentCanon();
    if (!canon || !canon.accepted_fact) throw new ProtocolError(409, "nothing accepted yet");
    const id = `promote-${canon.seq}-${String(canon.sha).slice(0, 12)}-r${Date.now().toString(36)}`;
    await this.env.PROMOTE_WORKFLOW.create({ id, params: this.ciParams(canon.attempt_id as string, canon.sha as string) });
    return { workflow: id };
  }

  /** What the refresh Workflow needs: where to read the old change, where to push it, and the new canon.json. */
  async refreshJob(attemptId: string): Promise<Record<string, string> | null> {
    const attempt = this.attempt(attemptId);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    const from = claim?.refreshedFrom ? this.claim(claim.refreshedFrom) : null;
    const old = from ? this.attempt(from.attemptId) : null;
    // Already pushed (a retried Workflow) or not a refresh: nothing to do.
    if (!attempt || !claim || attempt.headSha || !old?.headSha || !old.baseSha) return null;
    const url = async (a: Attempt, scope: "read" | "write") => {
      using repo = await this.env.ARTIFACTS.get(a.id);
      // An hour: the Workflow may wait for a container, and a retried step reuses these.
      const token = await repo.createToken(scope, 60 * 60);
      const u = new URL(a.remote);
      u.username = "x";
      u.password = token.plaintext;
      return u.toString();
    };
    return {
        NEW_URL: await url(attempt, "write"),
        OLD_URL: await url(old, "read"),
        OLD_ID: old.id,
        OLD_BASE: old.baseSha,
        OLD_HEAD: old.headSha,
        CANON_JSON: base64(new TextEncoder().encode(await this.attemptLedger(attemptId))),
        CANON_SEQ: String(this.currentCanon()?.seq ?? ""),
        AGENT: claim.agent,
        FACT: claim.factId,
        CLAIM: claim.id,
    };
  }

  /** The refresh Workflow's result. Pushed: the push event takes it from here. Otherwise the old claim goes back to its agent. */
  async refreshed(attemptId: string, outcome: "pushed" | "conflict" | "failed", detail: string) {
    if (outcome === "pushed") {
      if (detail === "repaired") this.sql.exec(`UPDATE claims SET refresh = 'repaired' WHERE attempt_id = ?`, attemptId);
      return this.broadcast();
    }
    const attempt = this.attempt(attemptId);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    if (!attempt || !claim?.refreshedFrom || attempt.headSha) return;
    // Nothing was pushed, so the new attempt never existed as far as anyone can tell.
    this.sql.exec(`DELETE FROM claims WHERE id = ?`, claim.id);
    this.sql.exec(`DELETE FROM attempts WHERE id = ?`, attempt.id);
    const note = outcome === "conflict" ? `conflict: ${detail.replace(/\s+/g, " ").trim().slice(0, 200)}` : "failed";
    // Which canon it conflicted with: a newer canon gets one more try (see retryConflicts).
    const seen = JSON.parse(this.meta("conflictSeq") ?? "{}") as Record<string, number>;
    seen[claim.refreshedFrom] = this.canonSeq();
    this.setMeta("conflictSeq", JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-300))));
    this.sql.exec(`UPDATE claims SET status = 'behind', refresh = ?, auto_wait = NULL WHERE id = ? AND status = 'superseded'`, note, claim.refreshedFrom);
    this.broadcast();
  }

  // ---- Internals ---------------------------------------------------------------------

  /**
   * Lands a Ready claim with no click when the policy allows it, and otherwise records why it waits.
   * backlog: a fact people wrote lands. charter: so does a fact an agent proposed, once a different agent has
   * independently made it true too, and a rule change, unless the charter locks the rule it replaces. Either way,
   * of two Ready facts that clash, only the one the charter ranks higher (or else the earlier-proposed one) lands.
   */
  private async autopilot(claimId: string | null, verdict: Verdict) {
    if (!claimId || verdict.outcome !== "ready") return;
    const claim = this.claim(claimId);
    if (!claim || claim.status !== "ready") return;
    const decision = this.autoDecision(claim);
    const batch = this.meta("batch") === "1";
    // Held only by the queue (a release or a train out): with batching it boards anyway, so a speculative train can
    // take it while the release runs instead of after.
    const queued = batch && !!decision && "wait" in decision && ((d) => !!d && !("wait" in d))(this.autoDecision(claim, true));
    this.sql.exec(`UPDATE claims SET auto_wait = ? WHERE id = ?`, decision && "wait" in decision ? decision.wait : null, claim.id);
    // Waiting on evidence still being produced: come back when it would time out, so the wait never goes stale.
    if (decision && "wait" in decision && Object.values(this.evidenceFor(claim)).some((e) => e.state === "pending")) {
      const at = Date.now() + REVIEW_STUCK_MS + 30_000;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }
    if (!decision || ("wait" in decision && !queued)) return this.broadcast();
    if (batch) {
      // Boarding: the first claim that may land opens a short window, so others that become Ready meanwhile leave with
      // it as one merge train (one candidate, one check, one release). The alarm departs it when the window closes.
      // During a release the window is short: the train is built and checked while the release runs.
      const until = Number(this.meta("boardingUntil") ?? 0);
      if (!until) {
        const at = Date.now() + (this.releasing() ? SPECULATIVE_BOARDING_MS : BOARDING_MS);
        this.setMeta("boardingUntil", String(at));
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      }
      this.sql.exec(`UPDATE claims SET auto_wait = ? WHERE id = ?`, "it's boarding the next merge train, which leaves in under a minute", claim.id);
      return this.broadcast();
    }
    if ("wait" in decision) return this.broadcast();
    try {
      await this.accept(claim.id, decision.how);
    } catch {
      // another attempt won the race, or canon moved: the re-judge decides what happens next
    }
  }

  // ---- A second pair of eyes: the advisory reviewer --------------------------------------------------------------

  /**
   * Bounded repair of a text conflict met while re-applying an attempt: the model resolves the markers in each file
   * (at most three), told what both sides are for. Each answer must leave no markers and keep every line outside the
   * conflicts, or the repair is off and the conflict goes back to the agent as before. A repair that passes is only
   * a candidate: it's pushed as the re-applied attempt and judged on every fact like any push.
   */
  async repairConflict(attemptId: string, files: Record<string, string>): Promise<Record<string, string> | null> {
    const attempt = this.attempt(attemptId);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    const paths = Object.keys(files);
    if (!claim || !this.env.AI || !paths.length || paths.length > 3) return null;
    const from = claim.refreshedFrom ? this.claim(claim.refreshedFrom) : null;
    const forkedAt = from ? (this.attempt(from.attemptId)?.createdAt ?? 0) : 0;
    const intents = [
      this.fact(claim.factId)?.sentence ?? claim.factId,
      ...this.rows(`SELECT * FROM facts WHERE status = 'canon' AND accepted_at > ?`, forkedAt).map(toFact).map((f) => f.sentence),
    ];
    const out: Record<string, string> = {};
    for (const path of paths) {
      const answer = await this.askModel(repairPrompt(path, files[path], intents)).catch(() => null);
      const text = fileFromAnswer(answer);
      if (!text || !validResolution(files[path], text)) return null;
      out[path] = text;
    }
    return out;
  }

  /** One answer from the frontier models on Workers AI: retried when they're out of capacity, then the next one down. */
  /**
   * The judge's conflict repair as a service, for comparisons: the same model and the same validity rule (every
   * conflict hunk resolved from its two sides, nothing outside them touched) the judge uses on its own re-applies.
   * Owner only. Returns the resolved file, or null when the model's answer isn't a valid resolution.
   */
  async repairText(path: string, conflicted: string, intents: string[]): Promise<{ file: string | null; detail: string }> {
    if (!this.env.AI) return { file: null, detail: "no model bound" };
    if (!parseConflicts(conflicted)) return { file: null, detail: "no conflict markers to resolve" };
    const answer = await this.askModel(repairPrompt(path, conflicted, intents.slice(0, 4)));
    const file = fileFromAnswer(answer);
    if (!file) return { file: null, detail: "the model's answer wasn't a file" };
    if (!validResolution(conflicted, file)) return { file: null, detail: "the model's file changed lines outside the conflicts, or didn't resolve them all" };
    return { file, detail: "resolved" };
  }

  private async askModel(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string | null> {
    for (const m of [REVIEW_MODELS[0], REVIEW_MODELS[0], ...REVIEW_MODELS.slice(1)]) {
      try {
        const out = (await this.env.AI!.run(m as Parameters<Ai["run"]>[0], { messages, max_completion_tokens: 24000, temperature: 0.1 } as never)) as {
          response?: unknown;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const answer = out.choices?.[0]?.message?.content ?? out.response;
        return typeof answer === "string" ? answer : null;
      } catch (err) {
        if (!/capacity|3040|overloaded|timeout/i.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    return null;
  }

  /**
   * A text conflict is against one canon. When canon has moved on since, the judge re-applies the attempt once more on
   * the new one (and its repair model can step in): the conflict may be gone, or now resolvable.
   */
  private async retryConflicts() {
    const seen = JSON.parse(this.meta("conflictSeq") ?? "{}") as Record<string, number>;
    const seq = this.canonSeq();
    for (const c of this.rows(`SELECT * FROM claims WHERE status = 'behind' AND (refresh LIKE 'conflict%' OR refresh = 'repaired') LIMIT 10`).map(toClaim)) {
      if ((seen[c.id] ?? 0) >= seq) continue;
      seen[c.id] = seq;
      this.sql.exec(`UPDATE claims SET refresh = NULL WHERE id = ?`, c.id);
      await this.autoRefresh(c.id).catch(() => {});
    }
    this.setMeta("conflictSeq", JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-300))));
  }

  /** The owner asks for a fresh review of an attempt's latest commit (a new model, a changed prompt). */
  async reReview(attemptId: string): Promise<Review | null> {
    const attempt = this.attempt(attemptId);
    const verdict = this.latestVerdict(attemptId);
    if (!attempt?.claimId || !verdict) throw new ProtocolError(404, `no judged attempt ${attemptId}`);
    this.sql.exec(`DELETE FROM reviews WHERE attempt_id = ? AND sha = ?`, attemptId, verdict.sha);
    await this.startReview(attempt.claimId, verdict);
    return this.reviewOf(attemptId, verdict.sha);
  }

  private reviewOf(attemptId: string, sha: string): Review | null {
    const r = this.rows(`SELECT json FROM reviews WHERE attempt_id = ? AND sha = ?`, attemptId, sha)[0];
    return r ? (JSON.parse(r.json as string) as Review) : null;
  }

  /**
   * Once per Ready commit, a model that didn't write the change reads it: the fact it claims, the facts it must keep,
   * the deliberate breaks no fact caught, and the lines it added. Its notes are advice for whoever decides, never a
   * verdict, and each must quote the exact line it is about (see review.ts): a note quoting nothing real is dropped.
   */
  private async startReview(claimId: string, verdict: Verdict, again = false) {
    const claim = this.claim(claimId);
    const attempt = claim ? this.attempt(claim.attemptId) : null;
    const own = claim ? this.fact(claim.factId) : null;
    if (!claim || !own || !attempt?.baseSha || !this.env.AI) return;
    if (this.reviewOf(attempt.id, verdict.sha)) return;
    const put = (r: Review) => {
      this.sql.exec(`INSERT OR REPLACE INTO reviews (attempt_id, sha, json, at) VALUES (?, ?, ?, ?)`, attempt.id, verdict.sha, JSON.stringify(r), Date.now());
      this.broadcast();
    };
    const base = { model: REVIEW_MODELS[0], notes: [], dropped: 0, at: Date.now() };
    put({ status: "running", ...base, ...(again ? { detail: "a second try: the first review never finished" } : {}) });
    try {
      // Not knowing what changed is not "nothing changed", and a review of some of the files is not a review of the change.
      const changed = await this.changedPaths(attempt, verdict.sha);
      if (!changed) throw new Error("couldn't read which files the commit changed");
      const paths = changed.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|sql)$/.test(p) && !/(^|\/)(node_modules|dist)\//.test(p));
      if (!paths.length) return put({ status: "none", ...base, detail: "no source files changed" });
      if (paths.length > REVIEW_MAX_FILES) throw new Error(`the change touches ${paths.length} source files and the reviewer reads at most ${REVIEW_MAX_FILES}`);
      using repo = await this.env.ARTIFACTS.get(attempt.id);
      const text = async (ref: string, path: string) => (await (await repo.readFile({ ref, path }))?.text()) ?? "";
      const files: ReviewFile[] = [];
      for (const path of paths) files.push({ path, base: await text(attempt.baseSha, path), head: await text(verdict.sha, path) });
      const m = this.rows(`SELECT json FROM mutations WHERE attempt_id = ? AND sha = ?`, attempt.id, verdict.sha)[0];
      const missed = m ? (JSON.parse(m.json as string) as Mutation).mutants.filter((x) => x.caught === false).map((x) => `${x.op} at ${x.file}:${x.line}: ${x.before.trim().slice(0, 100)}`) : [];
      const canon = this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact).map((f) => f.sentence);
      // Coverage first: every changed file is shown whole or around every change, in as many passes as that takes. A
      // file too big even that way can't be reviewed, and a review of part of a change is not a review of it.
      // A file that can't be shown is left out and named: the other files are still reviewed (the notes stay useful
      // as advice), but coverage says the change wasn't reviewed whole, which required review evidence won't pass.
      const { batches, compact, tooBig } = reviewBatches(files);
      const d = verdict.data;
      const reviewGlobs = this.charter()?.review ?? [];
      const shown = files.filter((f) => !tooBig.includes(f.path));
      const specialists = specialistsFor(
        shown.map((f) => { const c = changedLines(f.base, f.head); return { path: f.path, added: [...c.added, ...c.removed].map((x) => x.text) }; }),
        !d || !d.complete || d.destructive.length + d.additive.length + (d.writes?.length ?? 0) > 0,
        (p) => reviewGlobs.length > 0 && inScope(reviewGlobs, [p]),
      );
      type Answer = { response?: unknown; choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const ask = (model: string, batch: ReviewFile[], who: Specialist) =>
        this.env.AI!.run(model as Parameters<Ai["run"]>[0], {
          messages: reviewPrompt(own.sentence, canon, missed, batch, undefined, who),
          response_format: { type: "json_schema", json_schema: { name: "review", schema: REVIEW_SCHEMA } },
          // Reasoning makes the notes right far more often; it needs room, or the answer comes back empty (finish_reason: length).
          max_completion_tokens: 24000,
          temperature: 0.2,
        } as never) as Promise<Answer>;
      const notes: ReviewNote[] = [];
      const unresolved: UnresolvedNote[] = [];
      let dropped = 0;
      let model = REVIEW_MODELS[0];
      for (const who of specialists) {
        for (const batch of batches) {
          // Frontier models on Workers AI can be briefly out of capacity: try again, then the next model down.
          let out: Answer | null = null;
          for (const m of [REVIEW_MODELS[0], REVIEW_MODELS[0], ...REVIEW_MODELS.slice(1)]) {
            try {
              out = await ask(m, batch, who);
              model = m;
              break;
            } catch (err) {
              if (!/capacity|3040|overloaded|timeout/i.test(String(err))) throw err;
              await new Promise((r) => setTimeout(r, 3_000));
            }
          }
          if (!out) throw new Error("every reviewer model was out of capacity");
          const answer = out.response ?? out.choices?.[0]?.message?.content;
          const judged = judgeAnswer(answer, out.choices?.[0]?.finish_reason, batch);
          if (!judged.ok) throw new Error(`${model.split("/").pop()} (${who} pass, ${batch.map((f) => f.path).join(", ")}): ${judged.detail}`);
          notes.push(...judged.notes.map((n) => ({ ...n, by: who })));
          unresolved.push(...judged.unresolved.map((n) => ({ ...n, by: who })));
          dropped += judged.dropped;
        }
      }
      // Every risk and intent finding is kept (they decide acceptance); only "untested" notes are capped for display.
      const ranked = rankNotes(notes);
      const coverage = { files: files.length, reviewed: files.length - tooBig.length, compact, ...(tooBig.length ? { omitted: tooBig } : {}), passes: specialists.length * batches.length, specialists };
      put({ status: "done", ...base, model, notes: ranked, dropped, ...(unresolved.length ? { unresolved } : {}), at: Date.now(), coverage });
    } catch (err) {
      put({ status: "error", ...base, detail: String(err instanceof Error ? err.message : err).slice(0, 200), at: Date.now() });
    }
    // A charter that routes the reviewer's risks to the owner had autopilot waiting for this review.
    if (this.charter()?.reviewRisk || this.charter()?.intentRisk) {
      const latest = this.latestVerdict(attempt.id);
      if (latest && latest.sha === verdict.sha) await this.autopilot(claimId, latest).catch(() => {});
    }
  }

  // ---- Checks that are checked: mutation testing ---------------------------------------------------------------

  /** A Ready claim with a probe fact gets its checks tested once per commit: CI builds deliberate breaks of its change. */
  private async startMutation(claimId: string, verdict: Verdict) {
    const claim = this.claim(claimId);
    const attempt = claim ? this.attempt(claim.attemptId) : null;
    if (!claim || !attempt?.baseSha || this.fact(claim.factId)?.check.kind !== "probe") return;
    if (this.rows(`SELECT 1 FROM mutations WHERE attempt_id = ? AND sha = ?`, attempt.id, verdict.sha).length) return;
    // At most two at a time (each builds several previews); the alarm starts the next ones.
    const busy = this.rows(`SELECT json, at FROM mutations`).filter((r) => (JSON.parse(r.json as string) as Mutation).status === "running" && Date.now() - Number(r.at) < 20 * 60_000).length;
    if (busy >= 2) return;
    // Account-wide, deliberate breaks are background work: they take spare capacity only, never ahead of a verification
    // waiting for a slot (the alarm asks again). Re-checked after the await, which let other alarms run.
    const slotKey = `mutate:${attempt.id}:${verdict.sha.slice(0, 12)}`;
    if (this.env.CAPACITY) {
      const cap = await this.account().acquireBackground(this.accountKey(slotKey), this.requireProject(), BACKGROUND_SLOTS).catch(() => "wait" as const);
      if (cap !== "go") return;
      if (this.rows(`SELECT 1 FROM mutations WHERE attempt_id = ? AND sha = ?`, attempt.id, verdict.sha).length) return void this.ctx.waitUntil(this.account().release(this.accountKey(slotKey)).catch(() => {}));
    }
    const running: Mutation = { status: "running", total: 0, caught: 0, mutants: [], at: Date.now() };
    this.sql.exec(`INSERT INTO mutations (attempt_id, sha, json, at) VALUES (?, ?, ?, ?)`, attempt.id, verdict.sha, JSON.stringify(running), Date.now());
    try {
      await this.env.MUTATE_WORKFLOW.create({ id: `mutate-${attempt.id}-${verdict.sha.slice(0, 12)}`, params: this.ciParams(attempt.id, verdict.sha) });
    } catch {
      this.sql.exec(`UPDATE mutations SET json = ? WHERE attempt_id = ? AND sha = ?`, JSON.stringify({ ...running, status: "none", reason: "start-failed" }), attempt.id, verdict.sha);
      if (this.env.CAPACITY) this.ctx.waitUntil(this.account().release(this.accountKey(slotKey)).catch(() => {}));
    }
  }

  /**
   * What the mutation Workflow needs: each source file the attempt changed, as it was where the attempt forked (null for
   * a new file). CI checkouts have no Git history, so the workflow diffs these against the checkout itself.
   */
  async mutationJob(repo: string): Promise<string | null> {
    const attempt = this.attempt(repo);
    // null means "no source changed" (not applicable); not knowing is an error, which leaves the evidence unavailable.
    if (!attempt?.baseSha || !attempt.headSha) throw new Error("the attempt has no fork point or head to mutate");
    const paths = await this.changedPaths(attempt, attempt.headSha);
    if (!paths) throw new Error("couldn't read which files the attempt changed");
    const changed = paths.filter((p) => /^src\/.*\.(ts|js|mjs)$/.test(p));
    if (!changed.length) return null;
    using artifacts = await this.env.ARTIFACTS.get(attempt.id);
    const files: Array<{ path: string; b64: string | null }> = [];
    let size = 0;
    for (const path of changed) {
      const blob = await artifacts.readFile({ ref: attempt.baseSha, path });
      const b64 = blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null;
      size += b64?.length ?? 0;
      if (size > NOVELTY_MAX_B64) break;
      files.push({ path, b64 });
    }
    return JSON.stringify(files);
  }

  /**
   * The mutants are built: run the attempt's own fact and every canon probe fact on each. A mutant is caught when any
   * fact fails on it; one that every fact still passes is a change to the code that no check notices.
   */
  async mutantsBuilt(repo: string, sha: string, built: Array<Omit<Mutant, "caught" | "by"> & { preview: string | null }>, reason?: Mutation["reason"]) {
    const attempt = this.attempt(repo);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    const own = claim ? this.fact(claim.factId) : null;
    if (!attempt || !own) return;
    const facts = [own, ...this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact)].filter((f) => f.check.kind === "probe");
    const mutants: Mutant[] = [];
    for (const m of built) {
      if (!m.preview) {
        mutants.push({ file: m.file, line: m.line, op: m.op, before: m.before, after: m.after, caught: null });
        continue;
      }
      const url = this.env.PREVIEW_URL_TEMPLATE.replace("{name}", m.preview);
      try {
        await waitForPreview(url);
      } catch {
        mutants.push({ file: m.file, line: m.line, op: m.op, before: m.before, after: m.after, caught: null });
        continue;
      }
      let by: string | undefined;
      for (const f of facts) {
        const r = await runCheck(f.check as ProbeCheck, url);
        if (!r.held && !/ failed: /.test(r.detail)) { by = f.id; break; }
      }
      mutants.push({ file: m.file, line: m.line, op: m.op, before: m.before, after: m.after, caught: !!by, ...(by ? { by } : {}) });
    }
    const checked = mutants.filter((m) => m.caught !== null);
    const startedAt = (JSON.parse((this.rows(`SELECT json FROM mutations WHERE attempt_id = ? AND sha = ?`, repo, sha)[0]?.json as string) ?? "{}") as Mutation).at;
    const result: Mutation = {
      status: checked.length || mutants.length ? "done" : "none",
      total: checked.length,
      caught: checked.filter((m) => m.caught).length,
      mutants,
      at: Date.now(),
      ...(startedAt ? { startedAt } : {}),
      ...(!mutants.length ? { reason: reason ?? "build-failed" } : {}),
    };
    this.sql.exec(`INSERT OR REPLACE INTO mutations (attempt_id, sha, json, at) VALUES (?, ?, ?, ?)`, repo, sha, JSON.stringify(result), Date.now());
    if (this.env.CAPACITY) this.ctx.waitUntil(this.account().release(this.accountKey(`mutate:${repo}:${sha.slice(0, 12)}`)).catch(() => {}));
    this.broadcast();
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending > Date.now() + 2_000) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    // With a charter threshold, autopilot was waiting for this.
    const v = this.latestVerdict(repo);
    if (claim && v && v.sha === sha && claim.status === "ready") this.ctx.waitUntil(this.startReview(claim.id, v).catch(() => {}));
    if (claim && v && v.sha === sha) await this.autopilot(claim.id, v);
  }

  // ---- Merge trains ----------------------------------------------------------------------------------------------

  /** When the boarding window closes: two or more riders leave as a merge train, one leaves on its own. */
  private async depart() {
    const until = Number(this.meta("boardingUntil") ?? 0);
    if (!until || Date.now() < until) return;
    // A train is out: look again in a few seconds; promoted() also brings it forward.
    if (this.activeTrain()) return void this.setMeta("boardingUntil", String(Date.now() + 15_000));
    // Halves of a failed train go first, one per departure.
    if ((JSON.parse(this.meta("bisect") ?? "[]") as string[][]).length) {
      const half = await this.departHalf().catch(() => "wait" as const);
      if (half !== "none") {
        const more = (JSON.parse(this.meta("bisect") ?? "[]") as string[][]).length > 0;
        return void this.setMeta("boardingUntil", more || half === "wait" ? String(Date.now() + 15_000) : "0");
      }
    }
    // A release is out: two or more riders leave now anyway, as a speculative train built on the canon being released.
    // It is checked while that release runs; it lands the moment the release goes out, or fails if it's held back.
    const releasing = this.releasing();
    if (releasing) {
      const riders = this.trainRiders(false, true);
      if (riders.length < 2) return void this.setMeta("boardingUntil", String(Date.now() + 15_000));
      this.setMeta("boardingUntil", "0");
      try {
        return await this.startTrain(riders);
      } catch {
        return void this.setMeta("boardingUntil", String(Date.now() + 15_000));
      }
    }
    this.setMeta("boardingUntil", "0");
    const riders = this.trainRiders();
    if (riders.length >= 2) {
      try {
        return await this.startTrain(riders);
      } catch {
        return void this.setMeta("boardingUntil", String(Date.now() + 15_000));
      }
    }
    // One rider, or only claims that can't ride (a rule change, or a failed train's riders): one lands on its own,
    // and the next departure takes the next one.
    const one = riders[0] ?? this.trainRiders(true)[0];
    if (!one) return;
    this.sql.exec(`UPDATE claims SET auto_wait = NULL WHERE id = ?`, one.claim.id);
    await this.accept(one.claim.id, one.how).catch(() => {});
    if (this.trainRiders(true).length) this.setMeta("boardingUntil", String(Date.now() + 15_000));
  }

  /** A train still being built or checked (a stuck one stops blocking after 20 minutes). */
  private activeTrain(): Row | null {
    const t = this.rows(`SELECT * FROM trains WHERE status IN ('building', 'judging', 'waiting') ORDER BY created_at DESC LIMIT 1`)[0];
    return t && Date.now() - Number(t.created_at) < 20 * 60_000 ? t : null;
  }

  /** Ready claims the policy would land right now, one per fact, never a rule change, never one a failed train carried. */
  private trainRiders(singles = false, speculative = false): Array<{ claim: Claim; how: string }> {
    const failed = new Set(singles ? [] : (JSON.parse(this.meta("trainFailed") ?? "[]") as string[]));
    const seen = new Set<string>();
    const out: Array<{ claim: Claim; how: string }> = [];
    for (const c of this.rows(`SELECT * FROM claims WHERE status = 'ready' ORDER BY created_at`).map(toClaim)) {
      const fact = this.fact(c.factId);
      if (!fact || (fact.replaces && !singles) || seen.has(c.factId) || failed.has(c.id) || this.attempt(c.attemptId)?.frozen) continue;
      const d = this.autoDecision(c, speculative);
      if (!d || "wait" in d) continue;
      seen.add(c.factId);
      out.push({ claim: c, how: d.how });
      if (out.length === 8) break;
    }
    return out;
  }

  /** Forks a train attempt from canon and asks CI to apply every rider's own change to it, in order. */
  private async startTrain(riders: Array<{ claim: Claim; how: string }>, half = false) {
    const canon = this.currentCanon();
    const releasing = this.releasing();
    // While a release runs, only a train built on the very canon being released (speculation on its success).
    if (!canon || this.activeTrain() || (releasing !== null && releasing !== canon.seq)) return;
    const id = `${this.requireProject()}-${shortId()}`;
    const now = Date.now();
    const { remote } = await this.forkAttempt(canon.attempt_id as string, id, `merge train: ${riders.map((r) => r.claim.factId).join(", ")}`);
    this.sql.exec(`INSERT INTO attempts (id, claim_id, remote, base_attempt, base_sha, created_at) VALUES (?, NULL, ?, ?, ?, ?)`, id, remote, canon.attempt_id, canon.sha, now);
    this.sql.exec(
      `INSERT INTO trains (id, claims, hows, status, created_at, base_seq, speculative, half) VALUES (?, ?, ?, 'building', ?, ?, ?, ?)`,
      id, JSON.stringify(riders.map((r) => r.claim.id)), JSON.stringify(Object.fromEntries(riders.map((r) => [r.claim.id, r.how]))), now, canon.seq, releasing ? 1 : 0, half ? 1 : 0,
    );
    const ride = releasing
      ? `it's riding merge train ${id}, checked now on canon #${canon.seq} while that release runs: it lands the moment the release goes out`
      : `it's riding merge train ${id}: checked together with the others, released once`;
    for (const r of riders) this.sql.exec(`UPDATE claims SET auto_wait = ? WHERE id = ?`, ride, r.claim.id);
    this.broadcast();
    try {
      await this.env.TRAIN_WORKFLOW.create({ id: `train-${id}`, params: this.ciParams(id, canon.sha as string) });
    } catch (err) {
      await this.trainBuilt(id, "failed", [], String(err));
    }
  }

  /** What the train Workflow needs: the train's remote, each rider's own change, and the canon.json to commit. */
  async trainJob(trainId: string): Promise<Record<string, string> | null> {
    const train = this.rows(`SELECT * FROM trains WHERE id = ? AND status = 'building'`, trainId)[0];
    const attempt = this.attempt(trainId);
    if (!train || !attempt?.baseSha || attempt.headSha) return null;
    const parts = [];
    const facts: Record<string, FactDef> = {};
    for (const id of JSON.parse(train.claims as string) as string[]) {
      const c = this.claim(id);
      const a = c ? this.attempt(c.attemptId) : null;
      const f = c ? this.fact(c.factId) : null;
      if (!c || !a?.headSha || !a.baseSha || !f) continue;
      parts.push({ claim: c.id, agent: c.agent, url: await this.tokenUrl(a, "read"), base: a.baseSha, head: a.headSha });
      facts[c.id] = { id: f.id, sentence: f.sentence, check: f.check, ...(f.scope?.length ? { scope: f.scope } : {}) };
    }
    using repo = await this.env.ARTIFACTS.get(trainId);
    const blob = await repo.readFile({ ref: attempt.baseSha, path: "canon.json" });
    return {
      NEW_URL: await this.tokenUrl(attempt, "write"),
      PARTS: base64(new TextEncoder().encode(JSON.stringify(parts))),
      FACTS: base64(new TextEncoder().encode(JSON.stringify(facts))),
      CANON_BASE: base64(new Uint8Array(blob ? await blob.arrayBuffer() : new ArrayBuffer(0))),
    };
  }

  /** The train Workflow's result: pushed (the push event judges it as one) or failed (the riders land one by one). */
  async trainBuilt(trainId: string, outcome: "pushed" | "failed", included: string[], detail: string) {
    const train = this.rows(`SELECT * FROM trains WHERE id = ? AND status = 'building'`, trainId)[0];
    if (!train) return;
    const riders = JSON.parse(train.claims as string) as string[];
    const dropped = riders.filter((id) => !included.includes(id));
    for (const id of dropped) this.sql.exec(`UPDATE claims SET auto_wait = NULL WHERE id = ?`, id);
    if (outcome === "pushed" && included.length >= 1) {
      const note = dropped.length ? `${dropped.length} didn't apply cleanly on the others and land on their own` : null;
      this.sql.exec(`UPDATE trains SET status = 'judging', claims = ?, detail = ? WHERE id = ?`, JSON.stringify(included), note, trainId);
      this.broadcast();
      return;
    }
    await this.trainFailed(train, detail || "the combined candidate couldn't be built");
  }

  /** The train's verdict: every canon fact and every rider's fact must hold on the combined code, or nobody rides. */
  private async trainJudged(train: Row, verdict: Verdict) {
    const claims = (JSON.parse(train.claims as string) as string[]).map((id) => this.claim(id)).filter((c): c is Claim => !!c);
    const missing = claims.find((c) => !verdict.offers.includes(c.factId));
    const canon = this.currentCanon();
    const stale = !canon || verdict.canonSeq !== canon.seq || claims.some((c) => c.status !== "ready" || this.fact(c.factId)?.status !== "proposed");
    if (verdict.outcome !== "ready" || missing || stale) {
      const why = verdict.lost.length
        ? `the combined code broke “${this.fact(verdict.lost[0].factId)?.sentence ?? verdict.lost[0].factId}”: ${verdict.lost[0].detail}`
        : missing ? `“${this.fact(missing.factId)?.sentence ?? missing.factId}” doesn't hold on the combined code` : stale ? "canon or a rider changed while it was checked" : `its verdict was ${verdict.outcome}`;
      return this.trainFailed(train, why);
    }
    // Checked on a canon that is still being released: it waits for that release, then lands without being checked
    // again (its base is exactly what production will run). If the release is held back, its base is gone.
    if (this.releasing() === canon.seq) {
      this.sql.exec(`UPDATE trains SET status = 'waiting' WHERE id = ?`, train.id);
      for (const c of claims) this.sql.exec(`UPDATE claims SET auto_wait = ? WHERE id = ?`, `checked with merge train ${train.id} on canon #${canon.seq}: it lands the moment that release goes out`, c.id);
      this.broadcast();
      return;
    }
    const hows = JSON.parse(train.hows as string) as Record<string, string>;
    const now = Date.now();
    const trainId = train.id as string;
    // Each rider's own evidence (at its own commit), read before anything changes: the record keeps it.
    const riding = claims.map((c) => ({ claim: c, verdict: this.latestVerdict(c.attemptId), evidence: this.evidenceFor(c) }));
    const lacking = riding.flatMap((r) => this.exceptionsIn(r.evidence).map((e) => `${r.claim.factId}: ${e}`));
    if (lacking.length) return this.trainFailed(train, `a rider lacks evidence the charter requires (${lacking[0]})`);
    // Every write before the first await, as in accept().
    this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, trainId);
    for (const c of claims) {
      const others = claims.filter((o) => o !== c).map((o) => o.agent);
      this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, c.attemptId);
      this.sql.exec(`UPDATE facts SET status = 'canon', made_true_by = ?, accepted_at = ?, accepted_how = ? WHERE id = ?`,
        c.attemptId, now, `${hows[c.id] ?? "autopilot"}; landed in merge train ${trainId} with ${others.join(", ")}, checked and released together`, c.factId);
      this.setClaimStatus(c.id, "accepted");
      this.sql.exec(`UPDATE claims SET auto_wait = NULL WHERE id = ?`, c.id);
      this.sql.exec(`UPDATE claims SET status = 'superseded' WHERE fact_id = ? AND id != ? AND status NOT IN ('accepted', 'superseded')`, c.factId, c.id);
    }
    this.sql.exec(`INSERT INTO canon (attempt_id, sha, accepted_fact, facts_json, at) VALUES (?, ?, ?, ?, ?)`, trainId, verdict.sha, claims[0].factId, JSON.stringify(claims.map((c) => c.factId)), now);
    this.recordAcceptance(trainId, verdict, riding, `${[...new Set(claims.map((c) => (hows[c.id] ?? "autopilot").split(":")[0]))].join(", ")}: merge train ${trainId}, checked and released together`, [], now);
    this.sql.exec(`UPDATE trains SET status = 'landed' WHERE id = ?`, trainId);
    const seq = this.currentCanon()!.seq as number;
    this.setMeta("rejudge", "1");
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.broadcast();
    try {
      await this.env.PROMOTE_WORKFLOW.create({ id: `promote-${seq}-${verdict.sha.slice(0, 12)}`, params: this.ciParams(trainId, verdict.sha) });
    } catch {
      await this.promoted(seq, false);
    }
    for (const id of [trainId, ...claims.map((c) => c.attemptId)]) await this.revokeWriteTokens(id).catch(() => {});
  }

  /** A train that couldn't be built or didn't hold: its riders don't train again, and land one at a time. */
  private async trainFailed(train: Row, why: string) {
    const riders = JSON.parse(train.claims as string) as string[];
    const halves = this.splitTrain(riders);
    this.sql.exec(`UPDATE trains SET status = 'failed', detail = ? WHERE id = ?`, `${why.slice(0, 360)}${halves ? "; its riders try again as two halves" : ""}`, train.id);
    for (const id of riders) this.sql.exec(`UPDATE claims SET auto_wait = NULL WHERE id = ?`, id);
    this.broadcast();
    for (const id of riders) {
      const c = this.claim(id);
      const v = c ? this.latestVerdict(c.attemptId) : null;
      if (c && v) await this.autopilot(c.id, v);
    }
  }

  /**
   * A train that didn't hold doesn't say which rider broke it. Four or more riders split in two halves, each its own
   * train (in order, the next one at the next departure), so a train of eight finds its culprit in about three checks
   * instead of eight; fewer land one at a time. Either way they never ride with the rest of the queue again.
   */
  private splitTrain(riders: string[]): boolean {
    const failed = new Set([...(JSON.parse(this.meta("trainFailed") ?? "[]") as string[]), ...riders]);
    this.setMeta("trainFailed", JSON.stringify([...failed].slice(-200)));
    if (riders.length < 4) return false;
    const mid = Math.ceil(riders.length / 2);
    const queue = JSON.parse(this.meta("bisect") ?? "[]") as string[][];
    this.setMeta("bisect", JSON.stringify([riders.slice(0, mid), riders.slice(mid), ...queue].slice(0, 20)));
    return true;
  }

  /** The next half of a failed train leaves: as a train of its own, or alone if only one of it can still land. */
  private async departHalf(): Promise<"left" | "wait" | "none"> {
    const queue = JSON.parse(this.meta("bisect") ?? "[]") as string[][];
    while (queue.length) {
      const ids = queue.shift()!;
      // Members still being re-applied or judged: the half waits for them rather than leaving without them.
      if (ids.some((id) => ["open", "checking", "behind"].includes(this.claim(id)?.status ?? ""))) {
        this.setMeta("bisect", JSON.stringify([ids, ...queue]));
        return "wait";
      }
      const riders = ids.flatMap((id) => {
        const c = this.claim(id);
        if (!c || c.status !== "ready" || this.attempt(c.attemptId)?.frozen) return [];
        const d = this.autoDecision(c, true);
        return d && "how" in d ? [{ claim: c, how: d.how }] : [];
      });
      if (!riders.length) continue;
      // A single rider can't land while a release runs: it waits for the next departure.
      if (riders.length === 1 && this.releasing()) {
        this.setMeta("bisect", JSON.stringify([ids, ...queue]));
        return "wait";
      }
      this.setMeta("bisect", JSON.stringify(queue));
      if (riders.length >= 2) await this.startTrain(riders, true);
      else {
        this.sql.exec(`UPDATE claims SET auto_wait = NULL WHERE id = ?`, riders[0].claim.id);
        await this.accept(riders[0].claim.id, riders[0].how).catch(() => {});
      }
      return "left";
    }
    this.setMeta("bisect", "[]");
    return "none";
  }

  /** A reviewer's risk on an attempt the judge re-applied into this one, unless an agent has pushed since. */
  private inheritedRisk(claim: Claim): string | null {
    let cur: Claim | null = claim;
    for (let depth = 0; cur?.refreshedFrom && depth < 20; depth++) {
      // More than the judge's own push: the agent changed the code, and its new review is what counts.
      if (Number(this.rows(`SELECT COUNT(*) AS n FROM pushes WHERE attempt_id = ?`, cur.attemptId)[0]?.n ?? 0) > 1) return null;
      const prev: Claim | null = this.claim(cur.refreshedFrom);
      if (!prev) return null;
      const v = this.latestVerdict(prev.attemptId);
      const risk = v ? this.reviewOf(prev.attemptId, v.sha)?.notes.find((n) => n.kind === "risk") : undefined;
      if (risk) return `the reviewer flagged a risk at ${risk.file}:${risk.line} (${risk.note.slice(0, 120)}) on the attempt this one re-applies, and the code hasn't changed since`;
      cur = prev;
    }
    return null;
  }

  /**
   * The reviewer's track record, from what happened to the changes it read (no model grades itself). A risk it named
   * is "confirmed" when that attempt later broke a fact (rejected, held back at release, rolled back), and "overruled"
   * when a person accepted it anyway and its release stayed healthy (likely a false alarm). A change it passed with no
   * risk that later broke a fact at release or in production is "missed". Per specialist, and in total, so owners can
   * tell how much weight a risk note deserves before letting it gate more.
   */
  private reviewerRecord() {
    type Tally = { reviews: number; risks: number; confirmed: number; overruled: number; missed: number; unavailable: number };
    const blank = (): Tally => ({ reviews: 0, risks: 0, confirmed: 0, overruled: 0, missed: 0, unavailable: 0 });
    const total = blank();
    const by: Record<string, Tally> = {};
    const broke = (attemptId: string) => {
      const v = this.latestVerdict(attemptId);
      const heldOrRolled = this.rows(`SELECT 1 FROM canon WHERE attempt_id = ? AND (health IN ('held', 'rolled-back', 'broken') OR deployed = -1)`, attemptId).length > 0;
      return v?.outcome === "contradicts" || !!v?.heldBack || heldOrRolled;
    };
    for (const row of this.rows(`SELECT attempt_id, json FROM reviews`)) {
      const r = JSON.parse(row.json as string) as Review;
      const attemptId = row.attempt_id as string;
      const passes = r.coverage?.specialists ?? ["general"];
      const tallies = [total, ...passes.map((p) => (by[p] ??= blank()))];
      if (r.status === "error") {
        for (const t of tallies) t.unavailable++;
        continue;
      }
      if (r.status !== "done") continue;
      const claim = this.rows(`SELECT * FROM claims WHERE attempt_id = ?`, attemptId).map(toClaim)[0];
      const accepted = claim?.status === "accepted";
      const byOwner = accepted && String(this.fact(claim.factId)?.acceptedHow ?? "").startsWith("the owner");
      const healthy = this.rows(`SELECT 1 FROM canon WHERE attempt_id = ? AND deployed = 1 AND COALESCE(health, 'healthy') = 'healthy'`, attemptId).length > 0;
      const didBreak = broke(attemptId);
      for (const t of tallies) t.reviews++;
      const risky = new Set(r.notes.filter((n) => n.kind === "risk").map((n) => n.by ?? "general"));
      for (const [i, t] of tallies.entries()) {
        const named = i === 0 ? risky.size > 0 : risky.has(passes[i - 1]);
        if (named) {
          t.risks++;
          if (didBreak) t.confirmed++;
          else if (byOwner && healthy) t.overruled++;
        } else if (didBreak && accepted) t.missed++;
      }
    }
    return { ...total, bySpecialist: by, basis: "confirmed: the attempt it flagged later broke a fact (rejected, held back, rolled back); overruled: a person accepted it and its release stayed healthy; missed: no risk named, and the accepted change broke a fact at release or in production" };
  }

  /** The facts a claim said it builds on (after) that aren't canon yet. */
  private pendingPrerequisites(claim: Claim): string[] {
    return (claim.after ?? []).filter((id) => this.fact(id)?.status !== "canon");
  }

  /** Required evidence that isn't a pass: what a person accepts over, and what autopilot never does. */
  private exceptionsIn(ev: { mutation: Evidence; review: Evidence; data: Evidence; scope: Evidence }): string[] {
    return (["mutation", "review", "data", "scope"] as const).filter((k) => ["failed", "unavailable", "pending"].includes(ev[k].state)).map((k) => `${k} ${ev[k].state} (${ev[k].detail})`);
  }

  /**
   * Writes the acceptance record for the canon just added (see Acceptance in protocol.ts): the exact commit, the facts
   * it lands with their checks and evidence, the verdict it rests on, who or what authorized it under which policy, and
   * how a failed release of it recovers. Synchronous, so it lands in the same write as the canon pointer.
   */
  private recordAcceptance(
    attemptId: string,
    verdict: Verdict,
    riders: Array<{ claim: Claim; verdict: Verdict | null; evidence: { mutation: Evidence; review: Evidence; data: Evidence; scope: Evidence } }>,
    authorizedBy: string,
    exceptions: string[],
    at: number,
    chosenBecause?: string,
  ) {
    const seq = this.currentCanon()!.seq as number;
    const charter = this.charter() ?? {};
    const policyText = JSON.stringify({ autoAccept: this.autoAccept(), charter });
    // The data assessment of everything that lands: complete only if every rider's was.
    const data = riders.map((r) => r.verdict?.data);
    const merged: DataChanges | undefined = data.every((d) => d)
      ? dataChanges([], data.every((d) => d!.complete), data.find((d) => !d!.complete)?.why)
      : undefined;
    if (merged) {
      merged.files = data.reduce((n, d) => n + (d!.files ?? 0), 0);
      for (const d of data) {
        merged.destructive.push(...d!.destructive);
        merged.additive.push(...d!.additive);
        merged.writes.push(...(d!.writes ?? []));
      }
    }
    const record: Acceptance = {
      ...(this.env.CF_VERSION_METADATA?.id ? { judge: this.env.CF_VERSION_METADATA.id } : {}),
      canonSeq: seq,
      sha: verdict.sha,
      attemptId,
      judgedOnCanon: verdict.canonSeq,
      facts: riders.map(({ claim, verdict: v, evidence }) => {
        const f = this.fact(claim.factId);
        return {
          id: claim.factId,
          sentence: f?.sentence ?? claim.factId,
          check: policyVersion(JSON.stringify(f?.check ?? null)),
          madeTrueBy: { attemptId: claim.attemptId, sha: v?.sha ?? "", ...(v?.seed ? { seed: v.seed } : {}), ...(v?.previewUrl ? { previewUrl: v.previewUrl } : {}) },
          evidence,
        };
      }),
      verdict: { kept: verdict.kept.length, skipped: verdict.skipped.length, ...(verdict.seed ? { seed: verdict.seed } : {}), previewUrl: verdict.previewUrl, judgedAt: verdict.judgedAt },
      environment: "a Workers Preview of the exact commit, built by Cloudflare CI (container standard-4); probes from the judge's Durable Object",
      authorizedBy,
      ...(chosenBecause ? { chosenBecause } : {}),
      exceptions,
      alternatives: riders.flatMap(({ claim }) =>
        this.rows(`SELECT * FROM claims WHERE fact_id = ? AND id != ? ORDER BY created_at`, claim.factId, claim.id).map(toClaim).slice(0, 12).map((c) => {
          const v = this.latestVerdict(c.attemptId);
          const outcome = c.declineReason ? `declined by a person: ${c.declineReason}`
            : v?.outcome === "contradicts" ? `rejected: broke ${v.lost.map((l) => l.factId).join(", ")}`
            : c.refreshedFrom ? `${c.status}, a re-apply of ${c.refreshedFrom} by the judge`
            : v ? `${c.status} (its verdict: ${v.outcome})` : c.status;
          return { factId: claim.factId, attemptId: c.attemptId, agent: c.agent, outcome: outcome.slice(0, 200) };
        }),
      ),
      policy: { autoAccept: this.autoAccept(), charter, version: policyVersion(policyText) },
      recovery: recoveryFor(merged),
      at,
    };
    this.sql.exec(`INSERT OR REPLACE INTO acceptances (seq, sha, json) VALUES (?, ?, ?)`, seq, verdict.sha, JSON.stringify(record));
  }

  /** The acceptance record of canon #seq (null for genesis, reverts, and canon accepted before records existed). */
  acceptance(seq: number): Acceptance | null {
    const row = this.rows(`SELECT json FROM acceptances WHERE seq = ?`, seq)[0];
    return row ? (JSON.parse(row.json as string) as Acceptance) : null;
  }

  /**
   * An acceptance record as served: the stored record, plus what became of the release (read now, never stored with
   * it), so a held release shows why it was held. A revert has no acceptance (the judge stepped canon back); it says so.
   */
  acceptanceView(seq: number) {
    const row = this.rows(`SELECT * FROM canon WHERE seq = ?`, seq)[0];
    const record = this.acceptance(seq);
    if (!row) return null;
    if (!record && row.reverts !== null && row.reverts !== undefined) {
      const held = this.rows(`SELECT health_detail FROM canon WHERE seq = ?`, row.reverts)[0];
      return { canonSeq: seq, sha: row.sha as string, at: row.at as number, revert: { of: row.reverts as number, why: `canon #${row.reverts} wasn't released, so canon stepped back to what production runs (canon always equals production): ${String(held?.health_detail ?? "its release didn't pass")}` } };
    }
    if (!record) return null;
    const revertedBy = this.rows(`SELECT seq FROM canon WHERE reverts = ?`, seq)[0];
    return {
      ...record,
      outcome: {
        release: row.deployed === 1 ? "deployed" : row.deployed === -1 ? "not released" : "in progress",
        health: (row.health as string | null) ?? null,
        detail: (row.health_detail as string | null) ?? null,
        versionId: (row.version_id as string | null) ?? null,
        revertedBy: (revertedBy?.seq as number | undefined) ?? null,
      },
    };
  }

  /**
   * The release Workflow asks before it touches production: is this exact commit what canon #seq authorized, and is
   * #seq still the latest canon? Anything else is a stale or unauthorized candidate and is refused (null means go).
   */
  releaseRefusal(seq: number, sha: string): string | null {
    const latest = this.currentCanon();
    if (!latest || (latest.seq as number) !== seq) return `canon #${seq} is no longer the latest canon (#${latest?.seq ?? "?"})`;
    if (latest.sha !== sha) return `canon #${seq} is ${String(latest.sha).slice(0, 7)}, not ${sha.slice(0, 7)}`;
    const record = this.acceptance(seq);
    if (record && record.sha !== sha) return `canon #${seq}'s acceptance authorized ${record.sha.slice(0, 7)}, not ${sha.slice(0, 7)}`;
    if (!record && latest.accepted_fact && Number(latest.at) > ACCEPTANCE_RECORDS_SINCE) return `canon #${seq} has no acceptance record`;
    return null;
  }

  // ---- The release fence ---------------------------------------------------------------------------------------
  //
  // One release run at a time holds canon #seq's release, as a lease it renews before every step that changes a Worker
  // (the release candidate, the rollback rehearsal, the version upload, the 0% gate, production). A run that stalls past
  // its lease is fenced out: the judge settles the release without it (asking production what it runs), and every later
  // step of the stale run is refused. The container commands carry the lease's deadline too, so a step that starts
  // late refuses itself, and a stale run that still reports a production change has that change undone.

  private lease(): Lease | null {
    return JSON.parse(this.meta("releaseLease") ?? "null") as Lease | null;
  }

  private holds(seq: number, holder: string): boolean {
    return holdsLease(this.lease(), seq, holder, Date.now());
  }

  private endLease(seq: number, why: string) {
    const l = this.lease();
    if (l && l.seq === seq && !l.ended) this.setMeta("releaseLease", JSON.stringify({ ...l, ended: why }));
  }

  /**
   * May release run `holder` take its next step for canon #seq? Grants or renews its lease (null-free answer), or says
   * why not. `settle`: the refusal means canon #seq can't be released as accepted (an unauthorized commit), so canon
   * goes back; otherwise the run just stops (a newer canon, another run, or its lease ran out).
   */
  async fence(seq: number, sha: string, holder: string): Promise<{ go: true; until: number } | { go: false; why: string; settle: boolean }> {
    // Every production-changing step of a release run asks here first, direct deploys included: none of them may be
    // overtaken by a judge write already on the wire. Waiting yields, and a judge write may register meanwhile (it had
    // checked ownership before this lease existed), so after each wait the barrier is checked again; once it's empty,
    // everything below (authority, then the lease) runs in this same turn, with no await, so a judge write either
    // registered before it (and this waited) or sees the lease and backs off.
    await this.judgeWriteSettled();
    while (Object.keys(this.judgeWrites()).length) await this.judgeWriteSettled();
    const refusal = this.releaseRefusal(seq, sha);
    if (refusal) return { go: false, why: refusal, settle: !refusal.includes("no longer the latest") };
    const row = this.rows(`SELECT deployed FROM canon WHERE seq = ?`, seq)[0];
    const republish = /-r[0-9a-z]+$/.test(holder);
    if (!republish && Number(row?.deployed) !== 0) return { go: false, why: `canon #${seq}'s release was already settled`, settle: false };
    if (republish && Number(row?.deployed) !== 1) return { go: false, why: `canon #${seq} isn't released, so there's nothing to republish`, settle: false };
    const now = Date.now();
    const d = leaseDecision(this.lease(), seq, holder, now);
    if (!d.go) return { go: false, why: d.why, settle: false };
    const until = now + RELEASE_LEASE_MS;
    this.setMeta("releaseLease", JSON.stringify({ seq, sha, holder, until } satisfies Lease));
    return { go: true, until };
  }

  /**
   * The rollback rehearsal's job: a change that touches stored data (or couldn't be fully inspected) is rehearsed
   * before production, by deploying the code production runs now onto the release candidate, which this release's
   * code just ran on. Returns where that code is, or null when no rehearsal is needed.
   */
  async rehearsalJob(seq: number, holder: string): Promise<Record<string, string> | null> {
    const record = this.acceptance(seq);
    if (!record?.recovery.rehearse || !this.holds(seq, holder)) return null;
    const prev = this.rows(`SELECT * FROM canon WHERE seq < ? AND deployed = 1 ORDER BY seq DESC LIMIT 1`, seq)[0];
    const a = prev ? this.attempt(prev.attempt_id as string) : null;
    if (!prev || !a) {
      this.setRehearsal(seq, "unavailable", "there is no released version before it to rehearse with");
      return null;
    }
    const target = await this.publishTargetFor(a.id, prev.sha as string);
    if ("refused" in target) {
      this.setRehearsal(seq, "unavailable", `the previous version can't be published onto the release candidate: ${target.refused}`);
      return null;
    }
    return { PREV_URL: await this.tokenUrl(a, "read"), PREV_SHA: prev.sha as string, PREV_SEQ: String(prev.seq), PREV_CONFIG: target.config, PREV_ENTRY: target.entry };
  }

  /**
   * The rehearsal's verdict: the facts that were canon before this release, on the release candidate now running the
   * previous code over the data this release's code wrote. Passed: rollback is known safe. Failed or unavailable: it
   * isn't, and autopilot doesn't release what it can't take back (a person's accept still goes out, and says so).
   * Returns whether the release may go on.
   */
  async rehearsalCheck(seq: number, holder: string, deployed: boolean, detail: string): Promise<boolean> {
    if (!this.holds(seq, holder)) return false;
    const record = this.acceptance(seq);
    if (!record) return true;
    if (deployed) {
      const url = this.env.CANDIDATE_URL.replace("{project}", this.requireProject());
      const landing = new Set(record.facts.map((f) => f.id));
      const makers = record.facts.map((f) => f.madeTrueBy.attemptId);
      const before = [
        ...this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact).filter((f) => !landing.has(f.id)),
        ...this.rows(`SELECT * FROM facts WHERE status = 'retired' AND retired_by IN (${makers.map(() => "?").join(",") || "''"})`, ...makers).map(toFact),
      ];
      // The new fact fails on the old code (that's what made it new): wait until it does, proof the old code answers.
      const own = record.facts.map((f) => this.fact(f.id)).find((f): f is Fact => f?.check.kind === "probe");
      let old = !own;
      for (let i = 0; own && i < 8 && !old; i++) {
        await new Promise((r) => setTimeout(r, i ? 5_000 : 15_000));
        old = !(await runCheck(own.check as ProbeCheck, url)).held;
      }
      if (!old) this.setRehearsal(seq, "unavailable", "the previous version never answered on the release candidate");
      else {
        const broke = await this.factsOn(seq, url, {}, undefined, true, before);
        if (broke.length) this.setRehearsal(seq, "failed", `the previous version broke “${broke[0].fact.sentence}” on data this release wrote: ${broke[0].detail}`);
        else {
          // State continuity: the release's code wrote a fixture per fact under reh-<seq> (candidateCheck). The previous
          // code now writes its own control under ctl-<seq>, then reads both back with GET steps only, each from the
          // values its own writer saved (inputs, generated ids). Every fact gets an explicit outcome (compatibilityVerdict).
          await this.continuityRun(seq, url, `ctl-${seq}`);
          const written = this.fixtures(seq, `reh-${seq}`);
          const control = this.fixtures(seq, `ctl-${seq}`);
          const coverage: CompatibilityCoverage = { compared: [], incompatible: [], inconclusive: [], unsupported: [], notApplicable: [], storage: "" };
          const config = await this.wranglerConfig(record.attemptId, record.sha);
          const basis = statelessBasis(storageBindings(config), this.meta("state") === "none");
          coverage.storage = basis.storage;
          for (const f of this.continuityFacts(seq).before) {
            const contract = fixtureContract(f.check as ProbeCheck);
            if (contract.kind === "not-applicable") coverage.notApplicable.push({ id: f.id, why: contract.why });
            else if (contract.kind === "unsupported") coverage.unsupported.push({ id: f.id, why: contract.why });
            else {
              const outcome = await compareFixtures(url, contract.check, { reh: `reh-${seq}`, ctl: `ctl-${seq}`, id: f.id }, written[f.id], control[f.id]);
              if (outcome.kind === "compared") coverage.compared.push(f.id);
              else if (outcome.kind === "incompatible") coverage.incompatible.push({ id: f.id, detail: outcome.detail });
              else coverage.inconclusive.push({ id: f.id, why: outcome.detail });
            }
          }
          const fresh = before.filter((f) => f.check.kind === "probe").length;
          const v = compatibilityVerdict(coverage, basis.stateless);
          this.setRehearsal(seq, v.state, v.state === "passed" ? `the previous version kept all ${fresh} of its facts; ${v.detail}` : v.detail, coverage);
        }
      }
    } else this.setRehearsal(seq, "unavailable", `the previous version couldn't be deployed onto the release candidate: ${detail.replace(/\s+/g, " ").slice(0, 160)}`);
    const after = this.acceptance(seq)!;
    for (const run of [`reh-${seq}`, `ctl-${seq}`]) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `fixtures:${run}`);
    if (after.recovery.rollbackSafe) return true;
    if (after.authorizedBy.startsWith("the owner")) {
      // A person's accept still goes out without a safe rollback; the record says so, and over what.
      const override = `released on ${after.authorizedBy.split(",")[0]}'s authority although its rollback rehearsal ${after.recovery.rehearsal?.state ?? "didn't run"}${after.recovery.rehearsal ? ` (${after.recovery.rehearsal.detail.slice(0, 160)})` : ""}`;
      this.sql.exec(`UPDATE acceptances SET json = ? WHERE seq = ?`, JSON.stringify({ ...after, recovery: { ...after.recovery, override } }), seq);
      return true;
    }
    const what = `its rollback rehearsal ${after.recovery.rehearsal?.state} (${after.recovery.rehearsal?.detail}), and autopilot doesn't release what it can't take back`;
    this.sql.exec(`UPDATE canon SET health = 'held', health_detail = ? WHERE seq = ?`, `${what}. Held back: production never served it.`, seq);
    this.broadcast();
    return false;
  }

  /**
   * The release candidate keeps long-lived data, so a release that touched stored data and then didn't ship leaves
   * the candidate's data in a shape production never had (its migration ran there): every later release would be
   * judged on it. While it still holds the release, the run rebuilds the candidate from what production runs: the
   * candidate Worker is deleted (its Durable Objects with it) and production's code deployed fresh. Returns where
   * that code is, or null when the release didn't touch stored data.
   */
  async candidateResetJob(seq: number, holder: string, always = false): Promise<Record<string, string> | null> {
    const record = this.acceptance(seq);
    if (!this.holds(seq, holder) || (!always && (!record || (record.recovery.rollbackSafe && !record.recovery.rehearse)))) return null;
    const prev = this.rows(`SELECT * FROM canon WHERE seq < ? AND deployed = 1 ORDER BY seq DESC LIMIT 1`, seq)[0];
    const a = prev ? this.attempt(prev.attempt_id as string) : null;
    if (!prev || !a) return null;
    const target = await this.publishTargetFor(a.id, prev.sha as string);
    if ("refused" in target) return null;
    return { PREV_URL: await this.tokenUrl(a, "read"), PREV_SHA: prev.sha as string, PREV_CONFIG: target.config, PREV_ENTRY: target.entry };
  }

  /**
   * The candidate's disposition: "dirty" when unreleased code ran on it and it couldn't be rebuilt (the rebuild
   * failed, or the run was fenced out first). A dirty candidate is never reused as it is: the next release rebuilds it
   * from production's code before deploying its own (and stops, as a platform failure, if that fails too).
   */
  candidateDirty(): string | null {
    return this.meta("candidateDirty");
  }

  markCandidate(dirty: string | null) {
    if (dirty) this.setMeta("candidateDirty", dirty.slice(0, 200));
    else this.sql.exec(`DELETE FROM meta WHERE key = 'candidateDirty'`);
  }

  /** Notes the candidate rebuild in the acceptance record (and the board's release detail). */
  candidateReset(seq: number, ok: boolean, detail: string) {
    this.markCandidate(ok ? null : `canon #${seq}'s release couldn't rebuild it: ${detail}`);
    const record = this.acceptance(seq);
    if (!record) return;
    const recovery = { ...record.recovery, candidateReset: { ok, detail: detail.replace(/\s+/g, " ").slice(0, 200), at: Date.now() } };
    this.sql.exec(`UPDATE acceptances SET json = ? WHERE seq = ?`, JSON.stringify({ ...record, recovery }), seq);
  }

  /** The facts a rehearsal carries across versions: the ones it lands first, then canon's, probes with their own state. */
  private continuityFacts(seq: number): { landing: Fact[]; before: Fact[] } {
    const record = this.acceptance(seq);
    const landing = new Set(record?.facts.map((f) => f.id) ?? []);
    const makers = record?.facts.map((f) => f.madeTrueBy.attemptId) ?? [];
    const own = (f: Fact) => f.check.kind === "probe" && (f.check as ProbeCheck).isolate !== false;
    return {
      landing: [...landing].map((id) => this.fact(id)).filter((f): f is Fact => !!f && own(f)),
      before: [
        ...this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact).filter((f) => !landing.has(f.id)),
        ...this.rows(`SELECT * FROM facts WHERE status = 'retired' AND retired_by IN (${makers.map(() => "?").join(",") || "''"})`, ...makers).map(toFact),
      ].filter(own),
    };
  }

  /**
   * Writes the fixtures: every continuity fact's whole probe runs once, with one draw of its inputs from a fixed seed,
   * under a run identity of its own (so a read later sees exactly its own writes), and once more under one shared
   * identity (so old facts also run on state the new facts wrote, side by side). What each run saved (its inputs, the
   * ids it was given) is kept, because the read needs it to find the same state again.
   */
  private async continuityRun(seq: number, url: string, run: string) {
    const { landing, before } = this.continuityFacts(seq);
    const out: Record<string, { own: Fixture; shared: Fixture }> = {};
    for (const f of [...landing, ...before]) {
      const check = { ...(f.check as ProbeCheck), samples: 1 };
      const write = (identity: string) => writeFixture(check, url, `cont:${seq}:${f.id}`, { "x-canon-run": identity }).catch((err): Fixture => ({ ok: false, vars: {}, detail: String(err).slice(0, 160) }));
      const shared = await write(run);
      out[f.id] = { own: await write(`${run}:${f.id}`), shared };
    }
    this.setMeta(`fixtures:${run}`, JSON.stringify(out));
  }

  private fixtures(seq: number, run: string): Record<string, { own: Fixture; shared: Fixture } | undefined> {
    return JSON.parse(this.meta(`fixtures:${run}`) ?? "{}");
  }

  /** The release's Wrangler config, as accepted: what establishes whether the app keeps stored data at all. */
  private async wranglerConfig(repo: string, sha: string): Promise<string | null> {
    for (const path of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
      const text = await this.fileAtStrict(repo, sha, path).catch(() => null);
      if (text !== null) return text;
    }
    return null;
  }

  private setRehearsal(seq: number, state: "passed" | "failed" | "unavailable", detail: string, coverage?: CompatibilityCoverage) {
    const record = this.acceptance(seq);
    if (!record) return;
    const rehearsal = { state, detail, at: Date.now() };
    const recovery = { ...record.recovery, rehearsal, ...(coverage ? { coverage } : {}), rollbackSafe: state === "passed", how: state === "passed" ? `rehearsed: ${detail}` : record.recovery.how };
    this.sql.exec(`UPDATE acceptances SET json = ? WHERE seq = ?`, JSON.stringify({ ...record, recovery }), seq);
  }

  /** A release refused before it started (see releaseRefusal): nothing was deployed, so canon goes back. */
  async releaseRefused(seq: number, why: string) {
    this.sql.exec(`UPDATE canon SET health = 'held', health_detail = ? WHERE seq = ?`, `release refused: ${why}`, seq);
    await this.promoted(seq, false);
  }

  /**
   * The evidence the charter requires for a claim's latest verdict, each as an explicit state (see evidence.ts):
   * mutation (its facts catch deliberate breaks), review (a reviewer named no risk) and data (no destructive schema
   * change, which a Worker rollback can't undo; always required of autopilot).
   */
  private evidenceFor(claim: Claim): { mutation: Evidence; review: Evidence; data: Evidence; scope: Evidence } {
    const charter = this.charter() ?? {};
    const v = this.latestVerdict(claim.attemptId);
    const now = Date.now();
    const row = v ? this.rows(`SELECT json FROM mutations WHERE attempt_id = ? AND sha = ?`, claim.attemptId, v.sha)[0] : null;
    const mutation = mutationEvidence(charter.mutation, this.fact(claim.factId)?.check.kind, row ? (JSON.parse(row.json as string) as Mutation) : null, now);
    let review = reviewEvidence(charter.reviewRisk || charter.intentRisk, !!this.env.AI, v ? this.reviewOf(claim.attemptId, v.sha) : null, now, !!charter.intentRisk);
    // A risk named on the attempt this one re-applies stands until someone changes the code: re-running the same
    // change mustn't clear it by drawing a kinder review (a model's reviews vary from run to run).
    const inherited = review.state === "passed" || review.state === "not-applicable" ? this.inheritedRisk(claim) : null;
    if (inherited) review = { state: "failed", detail: inherited };
    const data = dataEvidence(v?.data);
    const out = v?.outside;
    const scope: Evidence = !claim.touches
      ? { state: "not-required", detail: "the claim declared no scope" }
      : !v || !out
        ? { state: "unavailable", detail: "the judge couldn't compare the change with the claim's declared scope" }
        : out.length
          ? { state: "failed", detail: `it changes ${out.slice(0, 3).join(", ")}${out.length > 3 ? ` and ${out.length - 3} more` : ""}, outside the files its claim said it would touch (${claim.touches.join(", ")})` }
          : { state: "passed", detail: `every file it changes is in its declared scope (${claim.touches.join(", ")})` };
    return { mutation, review, data, scope };
  }

  private autoDecision(claim: Claim, ignoreQueue = false): { how: string } | { wait: string } | null {
    const policy = this.autoAccept();
    const fact = this.fact(claim.factId);
    if (policy === "off" || fact?.status !== "proposed") return null;
    const charter = this.charter() ?? {};
    const releasing = ignoreQueue ? null : this.releasing();
    if (releasing) return { wait: `canon #${releasing} is being released first (one release at a time)` };
    const train = ignoreQueue ? null : this.activeTrain();
    if (train) {
      const riding = (JSON.parse(train.claims as string) as string[]).includes(claim.id);
      return { wait: riding ? `it's riding merge train ${train.id}: checked together with the others, released once` : `merge train ${train.id} is being checked first` };
    }
    // A safety valve: a fact held back at release twice doesn't land automatically again; the owner decides.
    // A release that failed without a fact breaking (the deploy itself failed, usually the platform) is retried more.
    // Only releases where this fact went out alone count: a train held back says nothing about each of its riders (it
    // splits in halves to find the one that broke).
    const releases = this.rows(
      `SELECT health FROM canon WHERE accepted_fact = ? AND (facts_json IS NULL OR json_array_length(facts_json) = 1) AND (deployed = -1 OR health IN ('held', 'rolled-back'))`,
      fact.id,
    );
    const heldTimes = releases.filter((r) => r.health === "held" || r.health === "rolled-back").length;
    const failedTimes = releases.length - heldTimes;
    if (heldTimes >= 2) return { wait: `it was held back at release ${heldTimes} times, so autopilot leaves it to the owner` };
    if (failedTimes >= 4) return { wait: `its release failed ${failedTimes} times without a fact breaking (the platform may be down), so autopilot leaves it to the owner` };
    if (fact.origin !== "backlog" && policy !== "charter") return { wait: "an agent proposed this fact, and autopilot only lands facts people wrote" };
    if (fact.replaces && charter.locked?.includes(fact.replaces)) return { wait: `it changes “${this.fact(fact.replaces)?.sentence ?? fact.replaces}”, which the charter locks` };
    const pending = this.pendingPrerequisites(claim);
    if (pending.length) return { wait: `it builds on “${this.fact(pending[0])?.sentence ?? pending[0]}”${pending.length > 1 ? ` and ${pending.length - 1} more` : ""}, which isn't canon yet` };
    const touched = this.latestVerdict(claim.attemptId)?.review ?? [];
    if (touched.length) return { wait: `it changes ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? " and more" : ""}, which the charter routes to review` };
    // Required evidence is non-compensatory: each piece must pass on its own, and one that couldn't be produced
    // (the platform failed, it timed out) is not a pass. The reviewer can't land or reject anything; a risk it names
    // (quoting the line) only makes autopilot wait for the owner.
    const ev = this.evidenceFor(claim);
    const notes: string[] = [];
    for (const [kind, e] of [["mutation", ev.mutation], ["review", ev.review], ["data", ev.data], ["scope", ev.scope]] as const) {
      const g = gate(kind, e);
      if (!g.ok) return { wait: g.wait };
      if (g.note && kind !== "data" && kind !== "scope") notes.push(g.note); // those two go in the acceptance record
    }
    const reasons: string[] = [fact.origin === "backlog" ? "a backlog fact people wrote" : ""];
    // A clash goes to the fact the charter ranks first, or else to the one proposed first. It's settled before
    // anything else: a fact that loses one waits, however many agents make it true.
    const rank = (f: Fact) => [charter.priority?.indexOf(f.id) ?? -1, f.createdAt] as const;
    const beats = (a: Fact, b: Fact) => {
      const [ra, ta] = rank(a), [rb, tb] = rank(b);
      if (ra !== rb) return ra === -1 ? false : rb === -1 ? true : ra < rb;
      return ta !== tb ? ta < tb : a.id < b.id;
    };
    const seen = new Set<string>();
    for (const c of this.clashesFor(claim.id)) {
      const other = this.fact(c.with.factId);
      if (!other || other.id === fact.id || seen.has(other.id)) continue;
      seen.add(other.id);
      if (!beats(fact, other)) return { wait: `it clashes with “${other.sentence}”, which ${charter.priority?.includes(other.id) ? "the charter ranks higher" : "was proposed first"}` };
      reasons.push(`it wins the clash with “${other.sentence}” (${charter.priority?.includes(fact.id) ? "ranked higher in the charter" : "proposed first"})`);
    }
    if (fact.origin !== "backlog") {
      const confirmed = this.rows(`SELECT agent FROM claims WHERE fact_id = ? AND status = 'ready' AND agent != ?`, fact.id, claim.agent)[0]?.agent as string | undefined;
      if (!confirmed) return { wait: "the charter needs a second agent to make this fact true independently" };
      reasons.unshift(`made true independently by ${claim.agent} and ${confirmed}`);
    }
    return { how: `${policy === "charter" ? "the charter" : "autopilot"}: ${[...reasons, ...notes].filter(Boolean).join("; ")}` };
  }

  private async evaluate(attempt: Attempt, sha: string, previewUrl: string, forced?: CheckResult, commands?: Record<string, CheckResult>): Promise<Verdict> {
    const canonSeq = (this.currentCanon()?.seq as number | undefined) ?? 0;
    const facts = this.rows(`SELECT * FROM facts WHERE status IN ('canon', 'proposed')`).map(toFact);
    const claim = attempt.claimId ? this.claim(attempt.claimId) : null;
    const claimedFact = claim ? this.fact(claim.factId) : null;
    // A revision may break the canon fact it replaces; that is the point of it.
    const retiring = claimedFact?.replaces && facts.some((f) => f.id === claimedFact.replaces && f.status === "canon") ? claimedFact.replaces : null;
    const changed = forced ? null : await this.changedPaths(attempt, sha);

    const results = new Map<string, CheckResult>();
    const skipped: string[] = [];
    const seed = crypto.randomUUID().slice(0, 8);
    await Promise.all(
      facts.map(async (f) => {
        if (forced) return results.set(f.id, forced);
        if (f.id !== claim?.factId && !inScope(f.scope, changed)) return skipped.push(f.id);
        // Random inputs come from the commit, a seed the judge draws now (after the push) and the fact: no agent can
        // know them before pushing, and the verdict records the seed so the run can be replayed.
        if (f.check.kind === "probe") return results.set(f.id, await runCheck(f.check, previewUrl, `${sha}:${seed}:${f.id}`));
        // Command facts ran in CI for this commit; a re-judge reuses that result (same commit, same answer).
        const ran = commands?.[f.id] ?? this.storedResult(attempt.id, sha, f.id);
        if (ran) results.set(f.id, ran);
        else skipped.push(f.id);
      }),
    );

    // A latency budget measures the platform as much as the code: under load (thirty builds at once) a correct change
    // missed a 400 ms budget at 1.7 s. So a budget that fails runs on canon's own preview at the same moment; if canon
    // is just as slow, the environment was, and when that's the only failure this is a platform error, retried later.
    if (!forced) {
      const canonPreview = (() => { const c = this.currentCanon(); return c ? (this.attempt(c.attempt_id as string)?.previewUrl ?? null) : null; })();
      const budgetMiss = (r: CheckResult | undefined) => !!r && !r.held && /p95 is \d+ ms, budget \d+ ms/.test(r.detail);
      const misses = facts.filter((f) => f.status === "canon" && f.check.kind === "probe" && budgetMiss(results.get(f.id)));
      if (misses.length && canonPreview && canonPreview !== previewUrl) {
        const slow = (await Promise.all(misses.map(async (f) => (budgetMiss(await runCheck(f.check as ProbeCheck, canonPreview)) ? f.id : null)))).filter(Boolean);
        const otherFailures = facts.some((f) => f.status === "canon" && !slow.includes(f.id) && results.get(f.id)?.held === false);
        if (slow.length && !otherFailures) {
          await this.couldNotJudge(attempt.id, sha, `the platform was slow: ${results.get(slow[0] as string)!.detail}, and canon's own preview missed the same budget just now`);
          const v = this.latestVerdict(attempt.id);
          if (v) return v;
        }
      }
    }

    const now = Date.now();
    for (const [factId, r] of results) {
      this.sql.exec(
        `INSERT OR REPLACE INTO results (attempt_id, sha, fact_id, held, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
        attempt.id, sha, factId, r.held ? 1 : 0, r.detail, now,
      );
    }
    const canonFacts = facts.filter((f) => f.status === "canon");
    const judged = canonFacts.filter((f) => results.has(f.id) && f.id !== retiring);
    const failed = judged.filter((f) => !results.get(f.id)!.held).map((f) => ({ fact: f, detail: results.get(f.id)!.detail }));
    // Breaking a fact that was canon when this attempt forked is a contradiction. Failing a fact accepted after
    // the fork means the attempt is behind: it predates that code, and the judge refreshes it onto the current canon.
    // That holds even for an attempt that built the very behaviour the fact tests, the other way (a clash): its own
    // preview is only a signal. The verdict that counts comes from the combined code, after the refresh: if the
    // re-applied attempt still breaks the fact, then it contradicts it.
    const newer = (x: { fact: Fact }) => (x.fact.acceptedAt ?? 0) > attempt.createdAt;
    const forkedFrom = attempt.baseAttempt ? (this.attempt(attempt.baseAttempt)?.previewUrl ?? null) : null;
    const opposed = new Map<string, string>();
    if (forkedFrom && !forced) {
      await Promise.all(
        failed.filter(newer).map(async (x) => {
          const detail = await this.interferes(x.fact, results.get(x.fact.id)!, forkedFrom, `${sha}:${seed}:${x.fact.id}`);
          if (detail) opposed.set(x.fact.id, detail);
        }),
      );
    }
    const lost = failed.filter((x) => !newer(x)).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const stale = failed.filter(newer).map((x) => (opposed.has(x.fact.id) ? { factId: x.fact.id, detail: opposed.get(x.fact.id)!, clash: true } : { factId: x.fact.id, detail: x.detail }));
    const riders = attempt.claimId ? [] : this.trainFacts(attempt.id);
    const ledger: Ledger = forced ? { status: "ok", detail: "not read: build failed" } : await this.checkLedger(attempt, sha, claimedFact, [...canonFacts, ...riders].filter((f) => f.origin !== "heldout"), retiring);
    // The charter's review paths this attempt touched: autopilot won't land it; the owner decides.
    const reviewGlobs = this.charter()?.review ?? [];
    const reviewed = reviewGlobs.length && changed ? changed.filter((p) => inScope(reviewGlobs, [p])) : [];
    // Not knowing which files changed is not "none of the review paths": the gate holds and the owner decides.
    if (reviewGlobs.length && !changed && !forced && attempt.claimId) reviewed.push("(the judge couldn't read which files this commit changed)");
    const data = forced ? undefined : await this.dataOf(attempt, sha, changed);
    // The claim's declared scope: every changed file must be one it said it would touch (canon.json is the judge's).
    const touches = claim?.touches;
    const outside = touches && !forced ? (changed ? changed.filter((p) => p !== "canon.json" && !inScope(touches, [p])) : ["(the judge couldn't read which files this commit changed)"]) : undefined;
    if (ledger.status === "tampered") lost.push({ factId: "canon.json", detail: ledger.detail });
    const claimed = claim ? results.get(claim.factId) : undefined;
    // Built on a canon that was never released (held back, rolled back): it carries code production never ran, so it
    // is behind whatever its preview says, and the judge re-applies its own change on the current canon.
    const unreleasedBase = attempt.baseAttempt
      ? this.rows(`SELECT seq FROM canon WHERE attempt_id = ? AND reverts IS NULL AND accepted_fact IS NOT NULL AND (deployed = -1 OR health IN ('held', 'rolled-back'))`, attempt.baseAttempt)[0]
      : null;
    if (unreleasedBase) stale.push({ factId: "canon", detail: `built on canon #${unreleasedBase.seq}, which was never released` });
    const behind = stale.length > 0 || ledger.status === "behind";
    const verdict: Verdict = {
      ...(this.env.CF_VERSION_METADATA?.id ? { judge: this.env.CF_VERSION_METADATA.id } : {}),
      attemptId: attempt.id,
      sha,
      previewUrl,
      canonSeq,
      outcome: unreleasedBase ? "behind" : lost.length ? "contradicts" : behind ? "behind" : claim && !claimed?.held ? "unproven" : "ready",
      stale,
      kept: judged.filter((f) => results.get(f.id)!.held).map((f) => f.id),
      lost,
      retires: retiring ? [retiring] : [],
      skipped: skipped.filter((id) => canonFacts.some((f) => f.id === id)),
      claimed: claim
        ? { factId: claim.factId, held: !!claimed?.held, detail: claimed?.detail ?? "not judged yet" }
        : { factId: "", held: true, detail: "genesis" },
      offers: facts.filter((f) => f.status === "proposed" && f.id !== claim?.factId && results.get(f.id)?.held).map((f) => f.id),
      ledger,
      judgedAt: now,
      seed,
      ...(reviewed.length ? { review: reviewed } : {}),
      ...(data ? { data } : {}),
      ...(outside ? { outside } : {}),
    };
    // first_at keeps the first verdict's time for the run report; a re-judge only replaces the verdict itself.
    this.sql.exec(
      `INSERT INTO verdicts (attempt_id, sha, json, at, first_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (attempt_id, sha) DO UPDATE SET json = excluded.json, at = excluded.at`,
      attempt.id, sha, JSON.stringify(verdict), now, now,
    );
    // Re-read the claim: the checks above awaited the network, and meanwhile another attempt may have been
    // accepted (superseding this claim). Never resurrect a settled claim with a stale status.
    const current = claim ? this.claim(claim.id) : null;
    if (current && LIVE.includes(current.status) && !attempt.frozen) this.setClaimStatus(current.id, verdict.outcome as ClaimStatus);
    return verdict;
  }

  /**
   * The stored-data changes in the lines this commit adds (see evidence.ts), from every changed file that could hold
   * data code, cached per commit. It says when it couldn't read everything: a missing file (deleted) adds nothing, but a
   * read that failed, an unknown file list, or too many files makes the inspection incomplete, never "no change".
   */
  private async dataOf(attempt: Attempt, sha: string, changed: string[] | null): Promise<DataChanges> {
    if (!changed || !attempt.baseSha) return dataChanges([], false, "couldn't read which files the commit changed");
    const paths = dataFiles(changed);
    if (paths.length > DATA_MAX_FILES) return dataChanges([], false, `${paths.length} changed files, more than the ${DATA_MAX_FILES} the judge reads`);
    const added: Array<{ path: string; lines: string[] }> = [];
    try {
      for (const path of paths) {
        // Its own cache, filled only by strict reads: the advisory overlap cache turns a failed read into "nothing
        // added", which must never stand in for evidence.
        const key = `data:${attempt.id}:${sha}:${path}`;
        if (!this.changedCache.has(key)) {
          const head = await this.fileAtStrict(attempt.id, sha, path);
          const base = await this.fileAtStrict(attempt.id, attempt.baseSha, path);
          this.changedCache.set(key, head === null ? [] : addedText(base ?? "", head));
        }
        added.push({ path, lines: this.changedCache.get(key) ?? [] });
      }
    } catch (err) {
      return dataChanges(added, false, `couldn't read ${paths[added.length]}: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`);
    }
    return dataChanges(added);
  }

  /** A file at a commit: its text, null when the file isn't there, and an error (thrown) when it couldn't be read. */
  private async fileAtStrict(repoName: string, ref: string, path: string): Promise<string | null> {
    using repo = await this.env.ARTIFACTS.get(repoName);
    const blob = await repo.readFile({ ref, path });
    return blob ? await blob.text() : null;
  }

  /** Files this attempt changed since it forked from canon, from the two Git trees in Artifacts. null = unknown (judge every fact). */
  private async changedPaths(attempt: Attempt, sha: string): Promise<string[] | null> {
    if (!attempt.baseSha || !attempt.claimId) return null;
    const key = `${attempt.id}:${sha}`;
    if (this.changedCache.has(key)) return this.changedCache.get(key)!;
    let changed: string[] | null = null;
    try {
      using repo = await this.env.ARTIFACTS.get(attempt.id);
      const [base, head] = await Promise.all([repo.readCommit(attempt.baseSha), repo.readCommit(sha)]);
      if (base && head) changed = await diffTrees(repo, base.treeHash, head.treeHash);
    } catch {
      changed = null;
    }
    this.changedCache.set(key, changed);
    return changed;
  }

  /** The facts a train attempt carries (its riders' claimed facts), or none if it isn't a train. */
  private trainFacts(attemptId: string): Fact[] {
    const t = this.rows(`SELECT claims FROM trains WHERE id = ?`, attemptId)[0];
    if (!t) return [];
    return (JSON.parse(t.claims as string) as string[]).flatMap((id) => {
      const f = this.fact(this.claim(id)?.factId ?? "");
      return f ? [f] : [];
    });
  }

  private storedResult(attemptId: string, sha: string, factId: string): CheckResult | null {
    const row = this.rows(`SELECT held, detail FROM results WHERE attempt_id = ? AND sha = ? AND fact_id = ?`, attemptId, sha, factId)[0];
    return row ? { held: row.held === 1, detail: row.detail as string, ms: 0 } : null;
  }

  private async checkLedger(attempt: Attempt, sha: string, claimed: Fact | null, canonFacts: Fact[], retiring: string | null): Promise<Ledger> {
    const file = await this.readCanonFile(attempt.id, sha);
    if (!file.ok) return { status: "tampered", detail: file.error };
    const retired = this.rows(`SELECT * FROM facts WHERE status = 'retired'`).map(toFact);
    return compareLedger(file.facts, canonFacts, claimed, attempt.createdAt, { retiring, retired });
  }

  private async readCanonFile(repoName: string, sha: string): Promise<({ ok: true } & CanonFile) | { ok: false; error: string }> {
    using repo = await this.env.ARTIFACTS.get(repoName);
    const blob = await repo.readFile({ ref: sha, path: "canon.json" });
    if (!blob) return { ok: false, error: "no canon.json at the repo root" };
    try {
      const file = JSON.parse(await blob.text()) as CanonFile;
      if (file.version !== 1 || !Array.isArray(file.facts)) throw new Error('canon.json must be {"version":1,"facts":[...]}');
      for (const f of [...file.facts, ...(file.backlog ?? [])]) {
        if (!/^[a-z0-9-]{3,48}$/.test(f.id) || typeof f.sentence !== "string") throw new Error(`canon.json fact "${f.id}" needs a slug id and a sentence`);
        validateCheck(f.check);
        validateScope(f.scope);
      }
      return { ok: true, ...file };
    } catch (err) {
      return { ok: false, error: errorStatus(err).message };
    }
  }

  private insertFact(def: FactDef, status: Fact["status"], origin: FactOrigin, createdAt: number, acceptedAt: number | null = null) {
    this.sql.exec(
      `INSERT INTO facts (id, sentence, check_json, status, created_at, accepted_at, scope_json, replaces, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      def.id, def.sentence, JSON.stringify(def.check), status, createdAt, acceptedAt,
      def.scope?.length ? JSON.stringify(def.scope) : null, def.replaces ?? null, origin,
    );
  }

  private async forkAttempt(baseRepo: string, name: string, description: string) {
    using base = await this.env.ARTIFACTS.get(baseRepo);
    const forked = await base.fork(name, { description, defaultBranchOnly: true });
    // Mint a fork-scoped write token with a known TTL. The fork may still be
    // materialising, so retry briefly before falling back to the fork's own token.
    for (let retry = 0; retry < 5; retry++) {
      try {
        using repo = await this.env.ARTIFACTS.get(name);
        const t = await repo.createToken("write", ATTEMPT_TOKEN_TTL_S);
        return { remote: forked.remote, token: t.plaintext, expiresAt: t.expiresAt };
      } catch (err) {
        if ((err as { code?: string }).code !== "FORK_IN_PROGRESS") throw err;
        await sleep(500 * (retry + 1));
      }
    }
    return { remote: forked.remote, token: forked.token, expiresAt: "" };
  }

  private async revokeWriteTokens(repoName: string) {
    using repo = await this.env.ARTIFACTS.get(repoName);
    const { tokens } = await repo.listTokens();
    await Promise.all(tokens.filter((t) => t.scope === "write" && t.state === "active").map((t) => repo.revokeToken(t.id)));
  }

  private ciParams(repo: string, sha: string): CiParams<CloudflareArtifacts> {
    const namespace = this.env.ARTIFACTS_NAMESPACE;
    return {
      provider: "cloudflare-artifacts",
      providerData: { namespace },
      event: { type: "push" },
      owner: namespace,
      repo,
      sha,
      remote: "cloudflare",
      trigger: "push",
      ref: "refs/heads/main",
      branch: "main",
    };
  }

  private charter(): Charter | null {
    try {
      return JSON.parse(this.meta("charter") ?? "null") as Charter | null;
    } catch {
      return null;
    }
  }

  private autoAccept(): AutoAccept {
    const v = this.meta("autoAccept");
    return v === "backlog" || v === "charter" ? v : "off";
  }

  private currentCanon(): Row | null {
    return this.rows(`SELECT * FROM canon ORDER BY seq DESC LIMIT 1`)[0] ?? null;
  }

  private latestVerdict(attemptId: string): Verdict | null {
    const row = this.rows(`SELECT json FROM verdicts WHERE attempt_id = ? ORDER BY at DESC LIMIT 1`, attemptId)[0];
    return row ? (JSON.parse(row.json as string) as Verdict) : null;
  }

  private fact(id: string): Fact | null {
    const row = this.rows(`SELECT * FROM facts WHERE id = ?`, id)[0];
    return row ? toFact(row) : null;
  }

  private claim(id: string): Claim | null {
    const row = this.rows(`SELECT * FROM claims WHERE id = ?`, id)[0];
    return row ? toClaim(row) : null;
  }

  private attempt(id: string): Attempt | null {
    const r = this.rows(`SELECT * FROM attempts WHERE id = ?`, id)[0];
    if (!r) return null;
    return {
      id: r.id as string,
      claimId: r.claim_id as string | null,
      remote: r.remote as string,
      baseAttempt: r.base_attempt as string | null,
      baseSha: (r.base_sha as string | null) ?? null,
      headSha: r.head_sha as string | null,
      previewUrl: r.preview_url as string | null,
      frozen: r.frozen === 1,
      createdAt: r.created_at as number,
    };
  }

  private setClaimStatus(id: string, status: ClaimStatus) {
    // Why autopilot waits only means something for a Ready claim; any other state clears it.
    if (status === "ready") this.sql.exec(`UPDATE claims SET status = ? WHERE id = ?`, status, id);
    else this.sql.exec(`UPDATE claims SET status = ?, auto_wait = NULL WHERE id = ?`, status, id);
  }

  private requireProject(): string {
    const project = this.meta("project");
    if (!project) throw new ProtocolError(409, "run genesis first");
    return project;
  }

  private meta(key: string): string | null {
    return (this.rows(`SELECT value FROM meta WHERE key = ?`, key)[0]?.value as string | undefined) ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value);
  }

  private rows(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.sql.exec<Row>(query, ...bindings).toArray();
  }
}

function toFact(r: Row): Fact {
  return {
    id: r.id as string,
    sentence: r.sentence as string,
    check: JSON.parse(r.check_json as string) as Check,
    scope: r.scope_json ? (JSON.parse(r.scope_json as string) as string[]) : null,
    replaces: (r.replaces as string | null) ?? null,
    origin: ((r.origin as FactOrigin | null) ?? "agent"),
    status: r.status as Fact["status"],
    proposedBy: r.proposed_by as string | null,
    madeTrueBy: r.made_true_by as string | null,
    createdAt: r.created_at as number,
    acceptedAt: r.accepted_at as number | null,
    retiredBy: (r.retired_by as string | null) ?? null,
    retiredAt: (r.retired_at as number | null) ?? null,
    acceptedHow: (r.accepted_how as string | null) ?? null,
    declinedAt: (r.declined_at as number | null) ?? null,
    declineReason: (r.decline_reason as string | null) ?? null,
  };
}

/** What a verdict observed going wrong, in one line (details of held-out facts already redacted), or null. */
function failureOf(v: Verdict | null | undefined, sentence: (id: string) => string): string | null {
  if (!v) return null;
  if (v.heldBack) return `held back at release: ${v.heldBack}`;
  if (v.outcome === "contradicts" && v.lost[0]) return `breaks “${sentence(v.lost[0].factId)}”: ${v.lost[0].detail}`;
  if (v.outcome === "unproven") return `its own fact doesn't hold: ${v.claimed.detail}`;
  if (v.outcome === "behind" && v.stale[0]) return `canon moved under it: “${sentence(v.stale[0].factId)}” fails on it (${v.stale[0].detail})`;
  if (v.outcome === "error") return `couldn't be judged (the platform, not the code): ${v.claimed.detail}`;
  return null;
}

function toClaim(r: Row): Claim {
  return {
    id: r.id as string,
    agent: r.agent as string,
    factId: r.fact_id as string,
    why: r.why as string,
    attemptId: r.attempt_id as string,
    status: r.status as ClaimStatus,
    createdAt: r.created_at as number,
    refreshedFrom: (r.refreshed_from as string | null) ?? null,
    refresh: (r.refresh as string | null) ?? null,
    declineReason: (r.decline_reason as string | null) ?? null,
    autoWait: (r.auto_wait as string | null) ?? null,
    ...(r.touches_json ? { touches: JSON.parse(r.touches_json as string) as string[] } : {}),
    ...(r.after_json ? { after: JSON.parse(r.after_json as string) as string[] } : {}),
  };
}

function validateCheck(check: Check) {
  if (check?.kind === "command") {
    if (typeof check.run !== "string" || !check.run.trim()) throw new ProtocolError(400, 'a command check needs {"kind":"command","run":"<shell command>"}');
    return;
  }
  if (!check || check.kind !== "probe" || !Array.isArray(check.steps) || check.steps.length === 0) {
    throw new ProtocolError(400, 'check must be {"kind":"probe","steps":[...]} or {"kind":"command","run":"..."}');
  }
  if (!check.steps.some((s) => s.expect)) throw new ProtocolError(400, "a check with no expectations cannot fail");
  if (check.samples !== undefined && (!Number.isInteger(check.samples) || check.samples < 1 || check.samples > 10)) throw new ProtocolError(400, "samples must be 1-10");
  if (check.isolate !== undefined && typeof check.isolate !== "boolean") throw new ProtocolError(400, "isolate must be true or false");
  if (check.fixture !== undefined && check.fixture !== "none") throw new ProtocolError(400, `fixture can only be "none" (the fact leaves no state a later read depends on)`);
  for (const [name, spec] of Object.entries(check.vars ?? {})) {
    const s = typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>) : {};
    const int = Array.isArray(s.int) && s.int.length === 2 && s.int.every(Number.isInteger) && s.int[0] <= s.int[1];
    const oneOf = Array.isArray(s.oneOf) && s.oneOf.length > 0;
    if (!/^[A-Za-z]\w*$/.test(name) || !(int || oneOf)) throw new ProtocolError(400, `input "${name}" must be {"int":[min,max]} or {"oneOf":[...]}`);
  }
  // Every {{name}} must be an input, or a value an earlier step saved.
  const known = new Set(Object.keys(check.vars ?? {}));
  for (const s of check.steps) {
    if (typeof s.path !== "string" || !s.path.startsWith("/")) throw new ProtocolError(400, "every step needs a path starting with /");
    if (s.repeat !== undefined && (!Number.isInteger(s.repeat) || s.repeat < 1 || s.repeat > 100)) throw new ProtocolError(400, "repeat must be 1-100");
    if (s.concurrent !== undefined && (!Number.isInteger(s.concurrent) || s.concurrent < 2 || s.concurrent > 20)) throw new ProtocolError(400, "concurrent must be 2-20");
    if (s.concurrent && s.repeat) throw new ProtocolError(400, "a step is either repeated (latency) or concurrent (a race), not both");
    // Never accept an assertion the runner can't apply: a race or a latency run has no single response to save from,
    // and only a repeated step has a latency to budget.
    if ((s.concurrent || s.repeat) && s.save) throw new ProtocolError(400, "save needs a single request: not on a repeated or concurrent step");
    if (s.expect?.p95Ms !== undefined && !(s.repeat && s.repeat > 1)) throw new ProtocolError(400, "p95Ms needs a repeated step (\"repeat\": 2 or more)");
    const counts = s.expect?.statusCounts;
    if (counts !== undefined) {
      const ns = typeof counts === "object" && counts ? Object.entries(counts) : [];
      if (!s.concurrent || !ns.length || ns.some(([k, v]) => !/^\d{3}$/.test(k) || !Number.isInteger(v) || (v as number) < 0) || ns.reduce((t, [, v]) => t + (v as number), 0) !== s.concurrent) {
        throw new ProtocolError(400, 'statusCounts needs a concurrent step, and its counts ({"201": 1, "409": 4}) must add up to concurrent');
      }
    }
    const names = new Set(s.concurrent ? [...known, "i"] : known);
    const unknown = templateNames([s.path, s.body, s.expect]).find((n) => !names.has(n));
    if (unknown) throw new ProtocolError(400, `{{${unknown}}} is not an input or a value an earlier step saved`);
    for (const name of Object.keys(s.save ?? {})) known.add(name);
  }
}

function validateScope(scope: unknown) {
  if (scope === undefined) return;
  if (!Array.isArray(scope) || scope.some((g) => typeof g !== "string" || !g)) throw new ProtocolError(400, "scope must be a list of file globs");
}

// Waits until the Preview is deployed. 404 or no connection means "not deployed yet" (the
// Workflow step retries). A Preview that keeps answering 5xx is deployed but broken: it is
// judged as it is, so a crashing attempt gets a verdict instead of hanging.
async function waitForPreview(origin: string) {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
      lastStatus = res.status;
      if (res.status < 500 && res.status !== 404) return;
    } catch {
      lastStatus = 0;
    }
    await sleep(2_000);
  }
  if (lastStatus >= 500) return;
  throw new Error(`preview ${origin} is not serving yet`);
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function shortId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
