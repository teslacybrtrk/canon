import { DurableObject } from "cloudflare:workers";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { Env } from "./env";
import type { Novelty } from "./commands";
import { compareLedger } from "./ledger";
import { runCheck, templateNames } from "./probe";
import {
  ProtocolError,
  errorStatus,
  type CanonFile,
  type CanonState,
  type Check,
  type CheckResult,
  type Claim,
  type ClaimStatus,
  type DeclareRequest,
  type Declared,
  type Fact,
  type FactDef,
  type FactOrigin,
  type Ledger,
  type Verdict,
  type World,
} from "./protocol";
import { SCHEMA, UPGRADES } from "./schema";
import { diffTrees, inScope } from "./scope";

const WORLD_TOKEN_TTL_S = 4 * 60 * 60;
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
   * Creates the genesis world. Either push a repo containing canon.json to the returned
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
    this.sql.exec(`INSERT INTO worlds (id, claim_id, remote, created_at) VALUES (?, NULL, ?, ?)`, id, created.remote, Date.now());
    if (importUrl) {
      // An import emits no push event, so start the same verify pipeline directly.
      using repo = await this.env.ARTIFACTS.get(id);
      const [head] = await repo.log({ limit: 1 });
      if (head) {
        this.sql.exec(`UPDATE worlds SET head_sha = ? WHERE id = ?`, head.hash, id);
        await this.env.CI_WORKFLOW.create({ id: `genesis-${head.hash.slice(0, 12)}`, params: this.ciParams(id, head.hash) });
      }
    }
    this.broadcast();
    return { worldId: id, remote: created.remote, token: created.token };
  }

  // ---- Move 1: read ----------------------------------------------------------------

  read(): CanonState {
    const canon = this.currentCanon();
    const facts = this.rows(`SELECT * FROM facts ORDER BY status, created_at`).map(toFact);
    const sentences = new Map(facts.map((f) => [f.id, f.sentence]));
    const claims = this.rows(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 200`).map((r) => {
      const claim = toClaim(r);
      return { ...claim, sentence: sentences.get(claim.factId) ?? claim.factId, verdict: this.latestVerdict(claim.worldId) };
    });
    return {
      project: this.meta("project") ?? "",
      canon: canon && { worldId: canon.world_id as string, sha: canon.sha as string, seq: canon.seq as number, previewUrl: this.world(canon.world_id as string)?.previewUrl ?? null },
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
    if (!canon) throw new ProtocolError(409, "no canon yet: genesis world has not passed its seed facts");
    if (!req.agent || !req.why) throw new ProtocolError(400, "agent and why are required");

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
      // (Command checks need CI: each push also runs them on the commit the world forked from.)
      const canonPreview = this.world(canon.world_id as string)?.previewUrl;
      if (canonPreview && def.check.kind === "probe") {
        const onCanon = await runCheck(def.check, canonPreview, `${canon.sha}:${def.id}`);
        if (onCanon.held) throw new ProtocolError(422, `"${def.sentence}" already holds on canon; it cannot fail, so it is not a new fact`);
      }
      this.insertFact(def, "proposed", "agent", Date.now());
      factId = def.id;
    }

    const claimId = `c-${shortId()}`;
    const worldId = `${project}-${shortId()}`;
    const { remote, token, expiresAt } = await this.forkWorld(canon.world_id as string, worldId, `${req.agent}: ${factId}`);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO worlds (id, claim_id, remote, base_world, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      worldId, claimId, remote, canon.world_id, canon.sha, now,
    );
    this.sql.exec(
      `INSERT INTO claims (id, agent, fact_id, why, world_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      claimId, req.agent, factId, req.why, worldId, now,
    );
    if (!("join" in req)) this.sql.exec(`UPDATE facts SET proposed_by = ? WHERE id = ?`, claimId, factId);
    const replaced = req.replaces ? this.claim(req.replaces) : null;
    if (replaced && replaced.factId === factId && LIVE.includes(replaced.status)) this.setClaimStatus(replaced.id, "superseded");
    this.broadcast();
    return { claim: this.claim(claimId)!, world: { id: worldId, remote, token, expiresAt, branch: "main" } };
  }

  // ---- Move 3: push (heard from the Artifacts push event) ----------------------------

  /** Records a push. Returns the world id if this repo is a Canon world that still accepts pushes. */
  pushed(repo: string, sha: string): string | null {
    const world = this.world(repo);
    if (!world || (world.frozen && world.claimId)) return null;
    this.sql.exec(`UPDATE worlds SET head_sha = ? WHERE id = ?`, sha, repo);
    if (world.claimId) this.setClaimStatus(world.claimId, "checking");
    this.broadcast();
    return repo;
  }

  /**
   * A proposed command fact must fail on the commit its world forked from, or it is not a new fact. CI rebuilds
   * that commit from the world's checkout with these files: each one the world changed, as it was at the fork.
   */
  async noveltyFor(repo: string, sha: string): Promise<Novelty | null> {
    const world = this.world(repo);
    const fact = world?.claimId ? this.fact(this.claim(world.claimId)?.factId ?? "") : null;
    if (!world?.baseSha || fact?.status !== "proposed" || fact.check.kind !== "command") return null;
    const changed = await this.changedPaths(world, sha);
    if (!changed) return null;
    using artifacts = await this.env.ARTIFACTS.get(world.id);
    const files: Novelty["files"] = [];
    let size = 0;
    for (const path of changed) {
      const blob = await artifacts.readFile({ ref: world.baseSha, path });
      const b64 = blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null;
      size += b64?.length ?? 0;
      if (size > NOVELTY_MAX_B64) return null;
      files.push({ path, b64 });
    }
    return { factId: fact.id, run: fact.check.run, files };
  }

  /**
   * The canon.json a new world must commit: canon's own file at the fork, plus the claimed fact (a revision drops
   * the fact it replaces; a backlog fact moves into the facts). This is what `canon claim` writes; MCP agents get it whole.
   */
  async worldLedger(worldId: string): Promise<string> {
    const world = this.world(worldId);
    const claim = world?.claimId ? this.claim(world.claimId) : null;
    const fact = claim ? this.fact(claim.factId) : null;
    if (!world?.baseSha || !fact) throw new ProtocolError(404, `no claimed world "${worldId}"`);
    using repo = await this.env.ARTIFACTS.get(worldId);
    const blob = await repo.readFile({ ref: world.baseSha, path: "canon.json" });
    if (!blob) throw new ProtocolError(404, "the world has no canon.json");
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
    const world = this.world(repo);
    if (!world) return [];
    // Before the first canon exists, genesis's own canon.json defines the facts.
    if (!world.claimId && !this.currentCanon()) {
      const file = await this.readCanonFile(repo, sha);
      if (!file.ok) return [];
      return [...file.facts, ...(file.backlog ?? [])].flatMap((f) => (f.check.kind === "command" ? [{ factId: f.id, run: f.check.run }] : []));
    }
    const claimedId = world.claimId ? this.claim(world.claimId)?.factId : undefined;
    const changed = await this.changedPaths(world, sha);
    return this.rows(`SELECT * FROM facts WHERE status IN ('canon', 'proposed')`)
      .map(toFact)
      .filter((f) => f.check.kind === "command" && (f.id === claimedId || inScope(f.scope, changed)))
      .map((f) => ({ factId: f.id, run: (f.check as { run: string }).run }));
  }

  // ---- Move 4: verdict --------------------------------------------------------------

  /**
   * Judges a world at a commit against canon. `commands` are the results of the command facts
   * the CI pipeline ran. Throws while the preview is not serving yet (the Workflow step retries).
   */
  async judge(repo: string, sha: string, previewUrl: string, commands: Record<string, CheckResult> = {}, notNew?: string): Promise<Verdict | null> {
    const world = this.world(repo);
    if (!world) return null;
    // A claimed command fact that already passed on the commit its world forked from cannot fail: it is not new.
    if (notNew && commands[notNew]?.held) {
      commands = { ...commands, [notNew]: { held: false, detail: "it already passes on the commit this world forked from, so it can't fail: not a new fact", ms: 0 } };
    }
    if (world.headSha && world.headSha !== sha) return null; // a newer push will be judged instead
    this.sql.exec(`UPDATE worlds SET preview_url = ?, head_sha = ? WHERE id = ?`, previewUrl, sha, repo);
    await waitForPreview(previewUrl);

    // Before the first canon exists, genesis's own canon.json defines the facts, the backlog and the policy.
    const isGenesis = !world.claimId && !this.currentCanon();
    if (isGenesis) {
      const file = await this.readCanonFile(repo, sha);
      this.sql.exec(`DELETE FROM facts`);
      const now = Date.now();
      for (const f of file.ok ? file.facts : []) this.insertFact(f, "canon", "seed", now, now);
      for (const f of file.ok ? (file.backlog ?? []) : []) this.insertFact(f, "proposed", "backlog", now);
      this.setMeta("autoAccept", file.ok && file.policy?.autoAccept === "backlog" ? "backlog" : "off");
    }
    const verdict = await this.evaluate(this.world(repo)!, sha, previewUrl, undefined, commands);

    // Genesis becomes the first canon only if it declares facts and satisfies all of them.
    if (isGenesis && verdict.outcome === "ready" && verdict.kept.length > 0) {
      this.sql.exec(`INSERT INTO canon (world_id, sha, at) VALUES (?, ?, ?)`, repo, sha, Date.now());
      this.sql.exec(`UPDATE worlds SET frozen = 1 WHERE id = ?`, repo);
      await this.revokeWriteTokens(repo);
      await this.scheduleProductionCheck(20_000);
    }
    this.broadcast();
    await this.autopilot(world.claimId, verdict);
    return verdict;
  }

  /** A world that does not build breaks every fact. */
  async buildFailed(repo: string, sha: string, detail: string): Promise<void> {
    const world = this.world(repo);
    if (!world || (world.headSha && world.headSha !== sha)) return;
    await this.evaluate(world, sha, "", { held: false, detail: `build failed: ${detail.slice(0, 300)}`, ms: 0 });
    this.broadcast();
  }

  /** The platform failed (container capacity, RPC, Workflows), not the code: say so, and let the agent push again. */
  couldNotJudge(repo: string, sha: string, detail: string): void {
    const world = this.world(repo);
    if (!world || (world.headSha && world.headSha !== sha)) return;
    const message = `could not be judged (platform error, not your code): ${detail.replace(/\s+/g, " ").slice(0, 200)}. Push again.`;
    const verdict: Verdict = {
      worldId: repo, sha, previewUrl: "", canonSeq: (this.currentCanon()?.seq as number | undefined) ?? 0, outcome: "error",
      stale: [], kept: [], lost: [], retires: [], skipped: [], offers: [],
      claimed: { factId: world.claimId ? (this.claim(world.claimId)?.factId ?? "") : "", held: false, detail: message },
      ledger: { status: "ok", detail: "not read" }, judgedAt: Date.now(),
    };
    this.sql.exec(`INSERT OR REPLACE INTO verdicts (world_id, sha, json, at) VALUES (?, ?, ?, ?)`, repo, sha, JSON.stringify(verdict), verdict.judgedAt);
    if (world.claimId) this.setClaimStatus(world.claimId, "error");
    this.broadcast();
  }

  /** Names of every Preview this project's verdicts used, so a reset can delete them. */
  previews(): string[] {
    const [head, tail] = this.env.PREVIEW_URL_TEMPLATE.split("{name}");
    const urls = this.rows(`SELECT DISTINCT json_extract(json, '$.previewUrl') AS url FROM verdicts`).map((r) => String(r.url ?? ""));
    return urls.filter((u) => u.startsWith(head) && u.endsWith(tail)).map((u) => u.slice(head.length, u.length - tail.length));
  }

  verdict(worldId: string): Verdict | null {
    return this.latestVerdict(worldId);
  }

  // ---- Review and promotion ---------------------------------------------------------

  /** A person (or the autopilot policy) accepts a change in the facts. The world comes along as evidence and becomes canon. */
  async accept(claimId: string) {
    const claim = this.claim(claimId);
    if (!claim) throw new ProtocolError(404, "no such claim");
    if (claim.status !== "ready") throw new ProtocolError(409, `claim is ${claim.status}, not ready`);
    if (this.fact(claim.factId)?.status !== "proposed") {
      this.setClaimStatus(claim.id, "superseded");
      this.broadcast();
      throw new ProtocolError(409, `"${claim.factId}" is no longer proposed; another world already settled it`);
    }
    const world = this.world(claim.worldId)!;
    const verdict = this.latestVerdict(world.id);
    const canon = this.currentCanon()!;
    if (!verdict || verdict.sha !== world.headSha) throw new ProtocolError(409, "the world moved since its verdict; wait for the new one");
    if (verdict.canonSeq !== canon.seq) {
      await this.evaluate(world, verdict.sha, verdict.previewUrl);
      this.broadcast();
      throw new ProtocolError(409, "canon moved since this verdict; re-judged, check the board");
    }

    // Freeze first: an accepted world can no longer change under the canon pointer.
    await this.revokeWriteTokens(world.id);
    const now = Date.now();
    const fact = this.fact(claim.factId)!;
    this.sql.exec(`UPDATE worlds SET frozen = 1 WHERE id = ?`, world.id);
    this.sql.exec(`UPDATE facts SET status = 'canon', made_true_by = ?, accepted_at = ? WHERE id = ?`, world.id, now, fact.id);
    // A revision retires the fact it replaces: the rule changed on purpose, and the history says who and why.
    if (fact.replaces) {
      this.sql.exec(`UPDATE facts SET status = 'retired', retired_by = ?, retired_at = ? WHERE id = ? AND status = 'canon'`, world.id, now, fact.replaces);
    }
    this.sql.exec(`INSERT INTO canon (world_id, sha, accepted_fact, at) VALUES (?, ?, ?, ?)`, world.id, verdict.sha, fact.id, now);
    this.setClaimStatus(claim.id, "accepted");
    this.sql.exec(
      `UPDATE claims SET status = 'superseded' WHERE fact_id = ? AND id != ? AND status NOT IN ('accepted', 'superseded')`,
      fact.id, claim.id,
    );

    const seq = this.currentCanon()!.seq as number;
    await this.env.PROMOTE_WORKFLOW.create({ id: `promote-${seq}-${verdict.sha.slice(0, 12)}`, params: this.ciParams(world.id, verdict.sha) });
    // Every other live world is now judged against the new canon. A world built before the fact is behind;
    // refreshed onto the new canon, a world that still loses it contradicts it: that is the conflict.
    this.setMeta("rejudge", "1");
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.broadcast();
    return { canonSeq: seq, worldId: world.id, sha: verdict.sha };
  }

  async promoted(seq: number, ok: boolean) {
    this.sql.exec(`UPDATE canon SET deployed = ? WHERE seq = ?`, ok ? 1 : -1, seq);
    // Production just changed: check canon's facts on it shortly, once the new version is serving.
    await this.scheduleProductionCheck(20_000);
    this.broadcast();
  }

  // One alarm, two jobs: re-judging live worlds after canon moves, and checking canon's facts on production hourly.
  async alarm() {
    // An alarm set before the production check existed was a re-judge.
    if (this.meta("rejudge") === "1" || this.meta("prodCheckAt") === null) {
      this.setMeta("rejudge", "0");
      const live = this.rows(`SELECT * FROM claims WHERE status IN (${LIVE.map(() => "?").join(",")})`, ...LIVE).map(toClaim);
      for (const claim of live) {
        const world = this.world(claim.worldId);
        if (world?.headSha && world.previewUrl) await this.evaluate(world, world.headSha, world.previewUrl);
      }
    }
    const canon = this.currentCanon();
    if (canon && Date.now() >= Number(this.meta("prodCheckAt") ?? 0)) {
      // While an accepted world is still deploying, production runs the old canon: wait for promoted().
      const deploying = canon.accepted_fact !== null && canon.deployed === 0;
      if (!deploying) await this.checkCanonOnProduction();
      this.setMeta("prodCheckAt", String(Date.now() + (deploying ? 5 * 60_000 : PRODUCTION_CHECK_EVERY_MS)));
    }
    this.broadcast();
    // A fact accepted while this alarm ran needs its re-judge now, not at the next production check.
    const next = this.meta("rejudge") === "1" ? Date.now() + 1_000 : Number(this.meta("prodCheckAt") ?? 0);
    if (next) await this.ctx.storage.setAlarm(next);
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
    // A fact's history is the worlds that tried to make it true, plus the worlds that broke it
    // while it was canon. Each trial links the Preview of the exact commit judged, not the
    // world's latest one, so a rejected attempt stays viewable as it was.
    const canonSince = fact.acceptedAt ?? Number.MAX_SAFE_INTEGER;
    const canonUntil = fact.retiredAt ?? Number.MAX_SAFE_INTEGER;
    const trials = this.rows(
      `SELECT r.world_id, r.sha, r.held, r.detail, r.at,
              COALESCE(NULLIF(json_extract(v.json, '$.previewUrl'), ''), w.preview_url) AS preview_url,
              c.agent, c.why, c.status, c.fact_id AS claimed_fact, w.created_at AS forked_at,
              f.replaces AS claim_replaces
         FROM results r
         JOIN worlds w ON w.id = r.world_id
         LEFT JOIN claims c ON c.id = w.claim_id
         LEFT JOIN facts f ON f.id = c.fact_id
         LEFT JOIN verdicts v ON v.world_id = r.world_id AND v.sha = r.sha
        WHERE r.fact_id = ? AND (c.fact_id = ? OR (r.at >= ? AND r.at <= ?))
        ORDER BY r.at DESC`,
      factId, factId, canonSince, canonUntil,
    );
    // Each failed trial is an attempt (the world claimed this fact), a revision (the world replaces
    // it on purpose), a contradiction (forked after the fact was canon and still broke it), or behind
    // (built before the fact existed, so it simply lacks the code).
    const kindOf = (t: Row) =>
      t.claimed_fact === factId ? "attempt"
        : t.claim_replaces === factId ? "revision"
          : (t.forked_at as number) >= canonSince ? "contradiction" : "behind";
    const claimFor = (worldId: string | null) => (worldId ? (this.rows(`SELECT * FROM claims WHERE world_id = ?`, worldId).map(toClaim)[0] ?? null) : null);
    const madeTrueBy = fact.madeTrueBy ? { world: this.world(fact.madeTrueBy), claim: claimFor(fact.madeTrueBy) } : null;
    const replacement = this.rows(`SELECT * FROM facts WHERE replaces = ? AND status = 'canon'`, factId).map(toFact)[0] ?? null;
    const retiredBy = fact.retiredBy ? { world: this.world(fact.retiredBy), claim: claimFor(fact.retiredBy), replacement } : null;
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

  // ---- Internals ---------------------------------------------------------------------

  /** With autoAccept "backlog", the first world that keeps canon and makes a backlog fact true lands on its own. */
  private async autopilot(claimId: string | null, verdict: Verdict) {
    if (!claimId || verdict.outcome !== "ready" || this.autoAccept() !== "backlog") return;
    const claim = this.claim(claimId);
    const fact = claim ? this.fact(claim.factId) : null;
    if (!claim || fact?.origin !== "backlog") return;
    try {
      await this.accept(claim.id);
    } catch {
      // another world won the race, or canon moved: the re-judge decides what happens next
    }
  }

  private async evaluate(world: World, sha: string, previewUrl: string, forced?: CheckResult, commands?: Record<string, CheckResult>): Promise<Verdict> {
    const canonSeq = (this.currentCanon()?.seq as number | undefined) ?? 0;
    const facts = this.rows(`SELECT * FROM facts WHERE status IN ('canon', 'proposed')`).map(toFact);
    const claim = world.claimId ? this.claim(world.claimId) : null;
    const claimedFact = claim ? this.fact(claim.factId) : null;
    // A revision may break the canon fact it replaces; that is the point of it.
    const retiring = claimedFact?.replaces && facts.some((f) => f.id === claimedFact.replaces && f.status === "canon") ? claimedFact.replaces : null;
    const changed = forced ? null : await this.changedPaths(world, sha);

    const results = new Map<string, CheckResult>();
    const skipped: string[] = [];
    await Promise.all(
      facts.map(async (f) => {
        if (forced) return results.set(f.id, forced);
        if (f.id !== claim?.factId && !inScope(f.scope, changed)) return skipped.push(f.id);
        // Random inputs are seeded by the commit and the fact: the same commit always gets the same inputs.
        if (f.check.kind === "probe") return results.set(f.id, await runCheck(f.check, previewUrl, `${sha}:${f.id}`));
        // Command facts ran in CI for this commit; a re-judge reuses that result (same commit, same answer).
        const ran = commands?.[f.id] ?? this.storedResult(world.id, sha, f.id);
        if (ran) results.set(f.id, ran);
        else skipped.push(f.id);
      }),
    );

    const now = Date.now();
    for (const [factId, r] of results) {
      this.sql.exec(
        `INSERT OR REPLACE INTO results (world_id, sha, fact_id, held, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
        world.id, sha, factId, r.held ? 1 : 0, r.detail, now,
      );
    }
    const canonFacts = facts.filter((f) => f.status === "canon");
    const judged = canonFacts.filter((f) => results.has(f.id) && f.id !== retiring);
    const failed = judged.filter((f) => !results.get(f.id)!.held).map((f) => ({ fact: f, detail: results.get(f.id)!.detail }));
    // Breaking a fact that was canon when this world forked is a contradiction. Failing a fact
    // accepted after the fork only means the world is behind: it predates that code. Whether its
    // own change truly conflicts shows once it is refreshed onto the current canon.
    const lost = failed.filter((x) => (x.fact.acceptedAt ?? 0) <= world.createdAt).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const stale = failed.filter((x) => (x.fact.acceptedAt ?? 0) > world.createdAt).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const ledger: Ledger = forced ? { status: "ok", detail: "not read: build failed" } : await this.checkLedger(world, sha, claimedFact, canonFacts, retiring);
    if (ledger.status === "tampered") lost.push({ factId: "canon.json", detail: ledger.detail });
    const claimed = claim ? results.get(claim.factId) : undefined;
    const behind = stale.length > 0 || ledger.status === "behind";
    const verdict: Verdict = {
      worldId: world.id,
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
    this.sql.exec(`INSERT OR REPLACE INTO verdicts (world_id, sha, json, at) VALUES (?, ?, ?, ?)`, world.id, sha, JSON.stringify(verdict), now);
    // Re-read the claim: the checks above awaited the network, and meanwhile another world may have been
    // accepted (superseding this claim). Never resurrect a settled claim with a stale status.
    const current = claim ? this.claim(claim.id) : null;
    if (current && LIVE.includes(current.status)) this.setClaimStatus(current.id, verdict.outcome as ClaimStatus);
    return verdict;
  }

  /** Files this world changed since it forked from canon, from the two Git trees in Artifacts. null = unknown (judge every fact). */
  private async changedPaths(world: World, sha: string): Promise<string[] | null> {
    if (!world.baseSha || !world.claimId) return null;
    const key = `${world.id}:${sha}`;
    if (this.changedCache.has(key)) return this.changedCache.get(key)!;
    let changed: string[] | null = null;
    try {
      using repo = await this.env.ARTIFACTS.get(world.id);
      const [base, head] = await Promise.all([repo.readCommit(world.baseSha), repo.readCommit(sha)]);
      if (base && head) changed = await diffTrees(repo, base.treeHash, head.treeHash);
    } catch {
      changed = null;
    }
    this.changedCache.set(key, changed);
    return changed;
  }

  private storedResult(worldId: string, sha: string, factId: string): CheckResult | null {
    const row = this.rows(`SELECT held, detail FROM results WHERE world_id = ? AND sha = ? AND fact_id = ?`, worldId, sha, factId)[0];
    return row ? { held: row.held === 1, detail: row.detail as string, ms: 0 } : null;
  }

  private async checkLedger(world: World, sha: string, claimed: Fact | null, canonFacts: Fact[], retiring: string | null): Promise<Ledger> {
    const file = await this.readCanonFile(world.id, sha);
    if (!file.ok) return { status: "tampered", detail: file.error };
    const retired = this.rows(`SELECT * FROM facts WHERE status = 'retired'`).map(toFact);
    return compareLedger(file.facts, canonFacts, claimed, world.createdAt, { retiring, retired });
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

  private async forkWorld(baseRepo: string, name: string, description: string) {
    using base = await this.env.ARTIFACTS.get(baseRepo);
    const forked = await base.fork(name, { description, defaultBranchOnly: true });
    // Mint a fork-scoped write token with a known TTL. The fork may still be
    // materialising, so retry briefly before falling back to the fork's own token.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        using repo = await this.env.ARTIFACTS.get(name);
        const t = await repo.createToken("write", WORLD_TOKEN_TTL_S);
        return { remote: forked.remote, token: t.plaintext, expiresAt: t.expiresAt };
      } catch (err) {
        if ((err as { code?: string }).code !== "FORK_IN_PROGRESS") throw err;
        await sleep(500 * (attempt + 1));
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

  private latestVerdict(worldId: string): Verdict | null {
    const row = this.rows(`SELECT json FROM verdicts WHERE world_id = ? ORDER BY at DESC LIMIT 1`, worldId)[0];
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

  private world(id: string): World | null {
    const r = this.rows(`SELECT * FROM worlds WHERE id = ?`, id)[0];
    if (!r) return null;
    return {
      id: r.id as string,
      claimId: r.claim_id as string | null,
      remote: r.remote as string,
      baseWorld: r.base_world as string | null,
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
    worldId: r.world_id as string,
    status: r.status as ClaimStatus,
    createdAt: r.created_at as number,
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
// judged as it is, so a crashing world gets a verdict instead of hanging.
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
