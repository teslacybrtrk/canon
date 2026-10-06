import { DurableObject } from "cloudflare:workers";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { Env } from "./env";
import type { Novelty } from "./commands";
import { compareLedger } from "./ledger";
import { progress, runCheck, templateNames } from "./probe";
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
} from "./protocol";
import { SCHEMA, UPGRADES } from "./schema";
import { diffTrees, inScope } from "./scope";

const ATTEMPT_TOKEN_TTL_S = 4 * 60 * 60;
const PREVIEW_READY_TIMEOUT_MS = 45_000;
const LIVE: ClaimStatus[] = ["checking", "contradicts", "unproven", "behind", "ready", "error"];

type Row = Record<string, SqlStorageValue>;
type AutoAccept = "off" | "backlog";

const LIVE_CHECK_TTL_MS = 30_000;
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

  // ---- Move 1: read ----------------------------------------------------------------

  read(): CanonState {
    const canon = this.currentCanon();
    const facts = this.rows(`SELECT * FROM facts ORDER BY status, created_at`).map(toFact);
    const sentences = new Map(facts.map((f) => [f.id, f.sentence]));
    const claims = this.rows(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 200`).map((r) => {
      const claim = toClaim(r);
      return { ...claim, sentence: sentences.get(claim.factId) ?? claim.factId, verdict: this.latestVerdict(claim.attemptId), clashes: this.clashesFor(claim.id) };
    });
    return {
      project: this.meta("project") ?? "",
      canon: canon && { attemptId: canon.attempt_id as string, sha: canon.sha as string, seq: canon.seq as number, previewUrl: this.attempt(canon.attempt_id as string)?.previewUrl ?? null },
      facts,
      claims,
      policy: { autoAccept: this.autoAccept() },
      production: JSON.parse(this.meta("production") ?? "null"),
    };
  }

  // ---- Move 2: declare --------------------------------------------------------------

  async declare(req: DeclareRequest): Promise<Declared> {
    const project = this.requireProject();
    const canon = this.currentCanon();
    if (!canon) throw new ProtocolError(409, "no canon yet: genesis attempt has not passed its seed facts");
    if (typeof req.agent !== "string" || !/^[\w.:@-]{1,40}$/.test(req.agent)) throw new ProtocolError(400, 'agent must be a name of 1-40 letters, digits or ". _ : @ -", e.g. "agent-3"');
    if (typeof req.why !== "string" || !req.why.trim()) throw new ProtocolError(400, "why is required: the reason for this change, in plain words");

    let factId: string;
    if ("join" in req) {
      const fact = this.fact(req.join);
      if (!fact || fact.status !== "proposed") throw new ProtocolError(404, `no proposed fact "${req.join}" to join`);
      factId = fact.id;
    } else {
      const def = req.fact;
      if (typeof def?.id !== "string" || !/^[a-z0-9-]{3,48}$/.test(def.id)) throw new ProtocolError(400, 'a fact needs "id": a 3-48 char slug');
      if (typeof def.sentence !== "string" || !def.sentence.trim()) throw new ProtocolError(400, 'a fact needs "sentence": what must be true, in plain words');
      if (this.fact(def.id)) throw new ProtocolError(409, `fact "${def.id}" exists; join it instead`);
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
      `INSERT INTO claims (id, agent, fact_id, why, attempt_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      claimId, req.agent, factId, req.why, attemptId, now,
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
    if (attempt.claimId) this.setClaimStatus(attempt.claimId, "checking");
    this.broadcast();
    return repo;
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
      this.setMeta("autoAccept", file.ok && file.policy?.autoAccept === "backlog" ? "backlog" : "off");
    }
    const verdict = await this.evaluate(this.attempt(repo)!, sha, previewUrl, undefined, commands);

    // Genesis becomes the first canon only if it declares facts and satisfies all of them.
    if (isGenesis && verdict.outcome === "ready" && verdict.kept.length > 0) {
      this.sql.exec(`INSERT INTO canon (attempt_id, sha, at) VALUES (?, ?, ?)`, repo, sha, Date.now());
      this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, repo);
      await this.revokeWriteTokens(repo);
      await this.scheduleProductionCheck(20_000);
    }
    this.broadcast();
    await this.autopilot(attempt.claimId, verdict);
    await this.followUp(attempt.claimId, verdict);
    return verdict;
  }

  /** An attempt that does not build breaks every fact. */
  async buildFailed(repo: string, sha: string, detail: string): Promise<void> {
    const attempt = this.attempt(repo);
    if (!attempt || (attempt.headSha && attempt.headSha !== sha)) return;
    await this.evaluate(attempt, sha, "", { held: false, detail: `build failed: ${detail.slice(0, 300)}`, ms: 0 });
    this.broadcast();
  }

  /** The platform failed (container capacity, RPC, Workflows), not the code: say so, and let the agent push again. */
  couldNotJudge(repo: string, sha: string, detail: string): void {
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
  }

  /** Names of every Preview this project's verdicts used, so a reset can delete them. */
  previews(): string[] {
    const [head, tail] = this.env.PREVIEW_URL_TEMPLATE.split("{name}");
    const urls = this.rows(`SELECT DISTINCT json_extract(json, '$.previewUrl') AS url FROM verdicts`).map((r) => String(r.url ?? ""));
    return urls.filter((u) => u.startsWith(head) && u.endsWith(tail)).map((u) => u.slice(head.length, u.length - tail.length));
  }

  async verdict(attemptId: string): Promise<Verdict | null> {
    await this.catchUp(attemptId);
    const verdict = this.latestVerdict(attemptId);
    const claimId = this.attempt(attemptId)?.claimId;
    if (!verdict || !claimId) return verdict;
    const next = this.rows(`SELECT attempt_id FROM claims WHERE refreshed_from = ?`, claimId)[0]?.attempt_id as string | undefined;
    return { ...verdict, clashes: this.clashesFor(claimId), ...(next ? { refreshedAs: next } : {}) };
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
  async accept(claimId: string) {
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
    if (!verdict || verdict.sha !== attempt.headSha) throw new ProtocolError(409, "the attempt moved since its verdict; wait for the new one");
    if (verdict.canonSeq !== canon.seq) {
      await this.evaluate(attempt, verdict.sha, verdict.previewUrl);
      this.broadcast();
      throw new ProtocolError(409, "canon moved since this verdict; re-judged, check the board");
    }

    // Every write happens before the first await, so a second accept can't slip in between: the attempt is frozen
    // (its pushes are ignored from here on), the fact is canon and the canon pointer has moved.
    const now = Date.now();
    const fact = this.fact(claim.factId)!;
    this.sql.exec(`UPDATE attempts SET frozen = 1 WHERE id = ?`, attempt.id);
    this.sql.exec(`UPDATE facts SET status = 'canon', made_true_by = ?, accepted_at = ? WHERE id = ?`, attempt.id, now, fact.id);
    // A revision retires the fact it replaces: the rule changed on purpose, and the history says who and why.
    if (fact.replaces) {
      this.sql.exec(`UPDATE facts SET status = 'retired', retired_by = ?, retired_at = ? WHERE id = ? AND status = 'canon'`, attempt.id, now, fact.replaces);
    }
    this.sql.exec(`INSERT INTO canon (attempt_id, sha, accepted_fact, at) VALUES (?, ?, ?, ?)`, attempt.id, verdict.sha, fact.id, now);
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

  /** The current canon's number: a deploy of an older one is skipped. */
  canonSeq(): number {
    return (this.currentCanon()?.seq as number | undefined) ?? 0;
  }

  async promoted(seq: number, ok: boolean) {
    this.sql.exec(`UPDATE canon SET deployed = ? WHERE seq = ?`, ok ? 1 : -1, seq);
    // Production just changed: check canon's facts on it shortly, once the new version is serving.
    await this.scheduleProductionCheck(20_000);
    this.broadcast();
  }

  // One alarm, two jobs: re-judging live attempts after canon moves, and checking canon's facts on production hourly.
  async alarm() {
    try {
      // An alarm set before the production check existed was a re-judge.
      if (this.meta("rejudge") === "1" || this.meta("prodCheckAt") === null) {
        this.setMeta("rejudge", "0");
        const live = this.rows(`SELECT * FROM claims WHERE status IN (${LIVE.map(() => "?").join(",")})`, ...LIVE).map(toClaim);
        const judged: Array<[string, Verdict]> = [];
        for (const claim of live) {
          const attempt = this.attempt(claim.attemptId);
          const judgedOn = attempt ? this.judgedPreview(attempt) : null;
          // A newer push that is still building gets its own verdict against the new canon.
          if (!attempt || !judgedOn) continue;
          try {
            judged.push([claim.id, await this.evaluate(attempt, judgedOn.sha, judgedOn.previewUrl)]);
          } catch {
            // One attempt that can't be re-judged right now must not stop the rest.
          }
        }
        this.broadcast();
        for (const [claimId, verdict] of judged) await this.followUp(claimId, verdict);
      }
      const canon = this.currentCanon();
      if (canon && Date.now() >= Number(this.meta("prodCheckAt") ?? 0)) {
        // While an accepted attempt is still deploying, production runs the old canon: wait for promoted().
        const deploying = canon.accepted_fact !== null && canon.deployed === 0;
        this.setMeta("prodCheckAt", String(Date.now() + (deploying ? 5 * 60_000 : PRODUCTION_CHECK_EVERY_MS)));
        if (!deploying) await this.checkCanonOnProduction().catch(() => {});
        // Previews don't change, but the set of Ready claims does: recheck their clashes on the same schedule.
        for (const r of this.rows(`SELECT id FROM claims WHERE status = 'ready'`)) await this.findClashes(r.id as string).catch(() => {});
      }
      this.broadcast();
    } finally {
      // A fact accepted while this alarm ran needs its re-judge now, not at the next production check.
      const next = this.meta("rejudge") === "1" ? Date.now() + 1_000 : Number(this.meta("prodCheckAt") ?? 0);
      if (next) await this.ctx.storage.setAlarm(next);
    }
  }

  /** The commit an attempt's last verdict judged and that commit's own Preview, if that commit is still its head. */
  private judgedPreview(attempt: Attempt): { sha: string; previewUrl: string } | null {
    const last = this.latestVerdict(attempt.id);
    return last?.previewUrl && last.sha === attempt.headSha ? { sha: last.sha, previewUrl: last.previewUrl } : null;
  }

  /** Runs every canon probe fact against production, one at a time so latency budgets don't skew each other. */
  private async checkCanonOnProduction() {
    const url = this.env.PRODUCTION_URL.replace("{project}", this.requireProject());
    const results: Record<string, { held: boolean; detail: string }> = {};
    for (const f of this.rows(`SELECT * FROM facts WHERE status = 'canon'`).map(toFact)) {
      if (f.check.kind !== "probe") continue;
      const r = await runCheck(f.check, url);
      results[f.id] = { held: r.held, detail: r.detail };
    }
    this.setMeta("production", JSON.stringify({ at: Date.now(), url, results }));
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
    const fact = this.fact(factId);
    if (!fact) throw new ProtocolError(404, "no such fact");
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
      rejected: trials.filter((t) => !t.held).map((t) => ({ ...t, kind: kindOf(t) })),
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
    const url = this.env.PRODUCTION_URL.replace("{project}", this.requireProject());
    const result = { ...(await runCheck(fact.check, url)), url, at: Date.now() };
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
      if (verdict.outcome === "ready") await this.findClashes(claimId);
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
   * fact runs on the other's preview: if the other attempt built that behaviour the other way, they clash, and
   * accepting one rejects the other. A plain text conflict is not a clash; the judge's refresh handles those.
   */
  private async findClashes(claimId: string) {
    const claim = this.claim(claimId);
    if (claim?.status !== "ready") return;
    const mine = this.attempt(claim.attemptId);
    const others = this.rows(`SELECT * FROM claims WHERE status = 'ready' AND id != ? AND fact_id != ?`, claim.id, claim.factId).map(toClaim);
    const found: Array<{ claimId: string; otherId: string; factId: string; detail: string }> = [];
    const probe = async (owner: Claim, on: Attempt | null, otherId: string) => {
      const fact = this.fact(owner.factId);
      const forkedFrom = on?.baseAttempt ? this.attempt(on.baseAttempt)?.previewUrl : null;
      const judgedOn = on ? this.judgedPreview(on) : null;
      if (fact?.check.kind !== "probe" || !judgedOn || !forkedFrom) return;
      const seed = `${judgedOn.sha}:${fact.id}`;
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
   * An attempt that is behind only lacks code canon gained after it forked. The judge re-applies its change on the
   * current canon as a new attempt (the same move as `canon refresh`) and pushes it, so the agent does nothing.
   * Only a text conflict goes back to the agent.
   */
  private async autoRefresh(claimId: string) {
    const claim = this.claim(claimId);
    const old = claim ? this.attempt(claim.attemptId) : null;
    if (claim?.status !== "behind" || claim.refresh || !old?.headSha || !old.baseSha) return;
    this.sql.exec(`UPDATE claims SET refresh = 'started' WHERE id = ?`, claim.id);
    let fresh: Declared | null = null;
    try {
      const canon = this.currentCanon()!;
      const why = `${claim.why.replace(/ \(refreshed onto canon \d+\)$/, "")} (refreshed onto canon ${canon.seq})`;
      fresh = await this.declare({ agent: claim.agent, why, join: claim.factId, replaces: claim.id });
      this.sql.exec(`UPDATE claims SET refreshed_from = ? WHERE id = ?`, claim.id, fresh.claim.id);
      await this.env.REFRESH_WORKFLOW.create({ id: `refresh-${fresh.attempt.id}`, params: this.ciParams(fresh.attempt.id, canon.sha as string) });
    } catch (err) {
      if (fresh) await this.refreshed(fresh.attempt.id, "failed", String(err));
      else this.sql.exec(`UPDATE claims SET refresh = 'failed' WHERE id = ?`, claim.id);
    }
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
    if (outcome === "pushed") return;
    const attempt = this.attempt(attemptId);
    const claim = attempt?.claimId ? this.claim(attempt.claimId) : null;
    if (!attempt || !claim?.refreshedFrom || attempt.headSha) return;
    // Nothing was pushed, so the new attempt never existed as far as anyone can tell.
    this.sql.exec(`DELETE FROM claims WHERE id = ?`, claim.id);
    this.sql.exec(`DELETE FROM attempts WHERE id = ?`, attempt.id);
    const note = outcome === "conflict" ? `conflict: ${detail.replace(/\s+/g, " ").trim().slice(0, 200)}` : "failed";
    this.sql.exec(`UPDATE claims SET status = 'behind', refresh = ? WHERE id = ? AND status = 'superseded'`, note, claim.refreshedFrom);
    this.broadcast();
  }

  // ---- Internals ---------------------------------------------------------------------

  /** With autoAccept "backlog", the first attempt that keeps canon and makes a backlog fact true lands on its own. */
  private async autopilot(claimId: string | null, verdict: Verdict) {
    if (!claimId || verdict.outcome !== "ready" || this.autoAccept() !== "backlog") return;
    const claim = this.claim(claimId);
    const fact = claim ? this.fact(claim.factId) : null;
    if (!claim || fact?.origin !== "backlog") return;
    try {
      await this.accept(claim.id);
    } catch {
      // another attempt won the race, or canon moved: the re-judge decides what happens next
    }
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
    await Promise.all(
      facts.map(async (f) => {
        if (forced) return results.set(f.id, forced);
        if (f.id !== claim?.factId && !inScope(f.scope, changed)) return skipped.push(f.id);
        // Random inputs are seeded by the commit and the fact: the same commit always gets the same inputs.
        if (f.check.kind === "probe") return results.set(f.id, await runCheck(f.check, previewUrl, `${sha}:${f.id}`));
        // Command facts ran in CI for this commit; a re-judge reuses that result (same commit, same answer).
        const ran = commands?.[f.id] ?? this.storedResult(attempt.id, sha, f.id);
        if (ran) results.set(f.id, ran);
        else skipped.push(f.id);
      }),
    );

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
    // the fork usually only means the attempt is behind: it predates that code, and the judge refreshes it onto
    // the current canon. But an attempt that built the very behaviour the fact tests, the other way, contradicts
    // it outright: no refresh can make both true.
    const newer = (x: { fact: Fact }) => (x.fact.acceptedAt ?? 0) > attempt.createdAt;
    const forkedFrom = attempt.baseAttempt ? (this.attempt(attempt.baseAttempt)?.previewUrl ?? null) : null;
    const opposed = new Map<string, string>();
    if (forkedFrom && !forced) {
      await Promise.all(
        failed.filter(newer).map(async (x) => {
          const detail = await this.interferes(x.fact, results.get(x.fact.id)!, forkedFrom, `${sha}:${x.fact.id}`);
          if (detail) opposed.set(x.fact.id, detail);
        }),
      );
    }
    const lost = failed.filter((x) => !newer(x) || opposed.has(x.fact.id)).map((x) => ({ factId: x.fact.id, detail: opposed.get(x.fact.id) ?? x.detail }));
    const stale = failed.filter((x) => newer(x) && !opposed.has(x.fact.id)).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const ledger: Ledger = forced ? { status: "ok", detail: "not read: build failed" } : await this.checkLedger(attempt, sha, claimedFact, canonFacts, retiring);
    if (ledger.status === "tampered") lost.push({ factId: "canon.json", detail: ledger.detail });
    const claimed = claim ? results.get(claim.factId) : undefined;
    const behind = stale.length > 0 || ledger.status === "behind";
    const verdict: Verdict = {
      attemptId: attempt.id,
      sha,
      previewUrl,
      canonSeq,
      outcome: lost.length ? "contradicts" : behind ? "behind" : claim && !claimed?.held ? "unproven" : "ready",
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
    };
    this.sql.exec(`INSERT OR REPLACE INTO verdicts (attempt_id, sha, json, at) VALUES (?, ?, ?, ?)`, attempt.id, sha, JSON.stringify(verdict), now);
    // Re-read the claim: the checks above awaited the network, and meanwhile another attempt may have been
    // accepted (superseding this claim). Never resurrect a settled claim with a stale status.
    const current = claim ? this.claim(claim.id) : null;
    if (current && LIVE.includes(current.status)) this.setClaimStatus(current.id, verdict.outcome as ClaimStatus);
    return verdict;
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

  private autoAccept(): AutoAccept {
    return this.meta("autoAccept") === "backlog" ? "backlog" : "off";
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
    this.sql.exec(`UPDATE claims SET status = ? WHERE id = ?`, status, id);
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
  };
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
    const unknown = templateNames([s.path, s.body, s.expect]).find((n) => !known.has(n));
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
