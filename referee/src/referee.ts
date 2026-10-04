import { DurableObject } from "cloudflare:workers";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { Env } from "./env";
import { compareLedger } from "./ledger";
import { runCheck } from "./probe";
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
  type Ledger,
  type Verdict,
  type World,
} from "./protocol";
import { SCHEMA } from "./schema";

const WORLD_TOKEN_TTL_S = 4 * 60 * 60;
const PREVIEW_READY_TIMEOUT_MS = 45_000;
const LIVE: ClaimStatus[] = ["checking", "contradicts", "unproven", "behind", "ready"];

type Row = Record<string, SqlStorageValue>;

/** One referee per project. The only writer of facts, claims and the canon pointer. */
export class Referee extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
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
    const facts = this.rows(`SELECT * FROM facts WHERE status != 'retired' ORDER BY status, created_at`).map(toFact);
    const sentences = new Map(facts.map((f) => [f.id, f.sentence]));
    const claims = this.rows(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 100`).map((r) => {
      const claim = toClaim(r);
      return { ...claim, sentence: sentences.get(claim.factId) ?? claim.factId, verdict: this.latestVerdict(claim.worldId) };
    });
    return {
      project: this.meta("project") ?? "",
      canon: canon && { worldId: canon.world_id as string, sha: canon.sha as string, seq: canon.seq as number, previewUrl: this.world(canon.world_id as string)?.previewUrl ?? null },
      facts,
      claims,
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
      const { id, sentence, check } = req.fact;
      if (!/^[a-z0-9-]{3,48}$/.test(id)) throw new ProtocolError(400, "fact id must be a 3-48 char slug");
      if (this.fact(id)) throw new ProtocolError(409, `fact "${id}" exists; join it instead`);
      validateCheck(check);
      // A fact canon already satisfies is not new, and a check that cannot fail is not a fact.
      const canonPreview = this.world(canon.world_id as string)?.previewUrl;
      if (canonPreview) {
        const onCanon = await runCheck(check, canonPreview);
        if (onCanon.held) throw new ProtocolError(422, `"${sentence}" already holds on canon; it cannot fail, so it is not a new fact`);
      }
      this.sql.exec(
        `INSERT INTO facts (id, sentence, check_json, status, created_at) VALUES (?, ?, ?, 'proposed', ?)`,
        id, sentence, JSON.stringify(check), Date.now(),
      );
      factId = id;
    }

    const claimId = `c-${shortId()}`;
    const worldId = `${project}-${shortId()}`;
    const { remote, token, expiresAt } = await this.forkWorld(canon.world_id as string, worldId, `${req.agent}: ${factId}`);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO worlds (id, claim_id, remote, base_world, created_at) VALUES (?, ?, ?, ?, ?)`,
      worldId, claimId, remote, canon.world_id, now,
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

  // ---- Move 4: verdict --------------------------------------------------------------

  /** Judges a world at a commit against canon. Throws while the preview is not serving yet (the Workflow step retries). */
  async judge(repo: string, sha: string, previewUrl: string): Promise<Verdict | null> {
    const world = this.world(repo);
    if (!world) return null;
    if (world.headSha && world.headSha !== sha) return null; // a newer push will be judged instead
    this.sql.exec(`UPDATE worlds SET preview_url = ?, head_sha = ? WHERE id = ?`, previewUrl, sha, repo);
    await waitForPreview(previewUrl);

    // Before the first canon exists, genesis's own canon.json defines the facts.
    const isGenesis = !world.claimId && !this.currentCanon();
    if (isGenesis) {
      const file = await this.readCanonFile(repo, sha);
      this.sql.exec(`DELETE FROM facts WHERE status = 'canon'`);
      const now = Date.now();
      for (const f of file.ok ? file.facts : []) {
        this.sql.exec(
          `INSERT INTO facts (id, sentence, check_json, status, created_at, accepted_at) VALUES (?, ?, ?, 'canon', ?, ?)`,
          f.id, f.sentence, JSON.stringify(f.check), now, now,
        );
      }
    }
    const verdict = await this.evaluate(this.world(repo)!, sha, previewUrl);

    // Genesis becomes the first canon only if it declares facts and satisfies all of them.
    if (isGenesis && verdict.outcome === "ready" && verdict.kept.length > 0) {
      this.sql.exec(`INSERT INTO canon (world_id, sha, at) VALUES (?, ?, ?)`, repo, sha, Date.now());
      this.sql.exec(`UPDATE worlds SET frozen = 1 WHERE id = ?`, repo);
      await this.revokeWriteTokens(repo);
    }
    this.broadcast();
    return verdict;
  }

  /** A world that does not build breaks every fact. */
  async buildFailed(repo: string, sha: string, detail: string): Promise<void> {
    const world = this.world(repo);
    if (!world || (world.headSha && world.headSha !== sha)) return;
    await this.evaluate(world, sha, "", { held: false, detail: `build failed: ${detail.slice(0, 300)}`, ms: 0 });
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

  /** A human accepts a change in the facts. The world comes along as evidence and becomes canon. */
  async accept(claimId: string) {
    const claim = this.claim(claimId);
    if (!claim) throw new ProtocolError(404, "no such claim");
    if (claim.status !== "ready") throw new ProtocolError(409, `claim is ${claim.status}, not ready`);
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
    this.sql.exec(`UPDATE worlds SET frozen = 1 WHERE id = ?`, world.id);
    this.sql.exec(`UPDATE facts SET status = 'canon', made_true_by = ?, accepted_at = ? WHERE id = ?`, world.id, now, claim.factId);
    this.sql.exec(`INSERT INTO canon (world_id, sha, accepted_fact, at) VALUES (?, ?, ?, ?)`, world.id, verdict.sha, claim.factId, now);
    this.setClaimStatus(claim.id, "accepted");
    this.sql.exec(
      `UPDATE claims SET status = 'superseded' WHERE fact_id = ? AND id != ? AND status NOT IN ('accepted', 'superseded')`,
      claim.factId, claim.id,
    );

    const seq = this.currentCanon()!.seq as number;
    await this.env.PROMOTE_WORKFLOW.create({ id: `promote-${seq}-${verdict.sha.slice(0, 12)}`, params: this.ciParams(world.id, verdict.sha) });
    // Every other live world is now judged against the new canon. A world that loses
    // the fact just accepted contradicts it: that is the conflict, not a textual diff.
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    this.broadcast();
    return { canonSeq: seq, worldId: world.id, sha: verdict.sha };
  }

  promoted(seq: number, ok: boolean) {
    this.sql.exec(`UPDATE canon SET deployed = ? WHERE seq = ?`, ok ? 1 : -1, seq);
    this.broadcast();
  }

  async alarm() {
    const live = this.rows(`SELECT * FROM claims WHERE status IN (${LIVE.map(() => "?").join(",")})`, ...LIVE).map(toClaim);
    for (const claim of live) {
      const world = this.world(claim.worldId);
      if (world?.headSha && world.previewUrl) await this.evaluate(world, world.headSha, world.previewUrl);
    }
    this.broadcast();
  }

  // ---- Why: the fact chain -----------------------------------------------------------

  why(factId: string) {
    const fact = this.fact(factId);
    if (!fact) throw new ProtocolError(404, "no such fact");
    // A fact's history is the worlds that tried to make it true, plus the worlds that broke it
    // while it was canon. Each trial links the Preview of the exact commit judged, not the
    // world's latest one, so a rejected attempt stays viewable as it was.
    const canonSince = fact.acceptedAt ?? Number.MAX_SAFE_INTEGER;
    const trials = this.rows(
      `SELECT r.world_id, r.sha, r.held, r.detail, r.at,
              COALESCE(NULLIF(json_extract(v.json, '$.previewUrl'), ''), w.preview_url) AS preview_url,
              c.agent, c.why, c.status
         FROM results r
         JOIN worlds w ON w.id = r.world_id
         LEFT JOIN claims c ON c.id = w.claim_id
         LEFT JOIN verdicts v ON v.world_id = r.world_id AND v.sha = r.sha
        WHERE r.fact_id = ? AND (c.fact_id = ? OR r.at >= ?)
        ORDER BY r.at DESC`,
      factId, factId, canonSince,
    );
    const madeTrueBy = fact.madeTrueBy ? { world: this.world(fact.madeTrueBy), claim: this.rows(`SELECT * FROM claims WHERE world_id = ?`, fact.madeTrueBy).map(toClaim)[0] ?? null } : null;
    return {
      fact,
      madeTrueBy,
      rejected: trials.filter((t) => !t.held),
      held: trials.filter((t) => t.held),
    };
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

  private async evaluate(world: World, sha: string, previewUrl: string, forced?: CheckResult): Promise<Verdict> {
    const canonSeq = (this.currentCanon()?.seq as number | undefined) ?? 0;
    const facts = this.rows(`SELECT * FROM facts WHERE status IN ('canon', 'proposed')`).map(toFact);
    const claim = world.claimId ? this.claim(world.claimId) : null;
    const results = new Map<string, CheckResult>();
    await Promise.all(facts.map(async (f) => results.set(f.id, forced ?? (await runCheck(f.check, previewUrl)))));

    const now = Date.now();
    for (const [factId, r] of results) {
      this.sql.exec(
        `INSERT OR REPLACE INTO results (world_id, sha, fact_id, held, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
        world.id, sha, factId, r.held ? 1 : 0, r.detail, now,
      );
    }
    const canonFacts = facts.filter((f) => f.status === "canon");
    const failed = canonFacts.filter((f) => !results.get(f.id)!.held).map((f) => ({ fact: f, detail: results.get(f.id)!.detail }));
    // Breaking a fact that was canon when this world forked is a contradiction. Failing a fact
    // accepted after the fork only means the world is behind: it predates that code. Whether its
    // own change truly conflicts shows once it is refreshed onto the current canon.
    const lost = failed.filter((x) => (x.fact.acceptedAt ?? 0) <= world.createdAt).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const stale = failed.filter((x) => (x.fact.acceptedAt ?? 0) > world.createdAt).map((x) => ({ factId: x.fact.id, detail: x.detail }));
    const ledger: Ledger = forced ? { status: "ok", detail: "not read: build failed" } : await this.checkLedger(world, sha, claim, canonFacts);
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
      kept: canonFacts.filter((f) => results.get(f.id)!.held).map((f) => f.id),
      lost,
      claimed: claim
        ? { factId: claim.factId, held: !!claimed?.held, detail: claimed?.detail ?? "fact retired" }
        : { factId: "", held: true, detail: "genesis" },
      offers: facts.filter((f) => f.status === "proposed" && f.id !== claim?.factId && results.get(f.id)!.held).map((f) => f.id),
      ledger,
      judgedAt: now,
    };
    this.sql.exec(`INSERT OR REPLACE INTO verdicts (world_id, sha, json, at) VALUES (?, ?, ?, ?)`, world.id, sha, JSON.stringify(verdict), now);
    if (claim && LIVE.includes(claim.status)) this.setClaimStatus(claim.id, verdict.outcome as ClaimStatus);
    return verdict;
  }

  private async checkLedger(world: World, sha: string, claim: Claim | null, canonFacts: Fact[]): Promise<Ledger> {
    const file = await this.readCanonFile(world.id, sha);
    if (!file.ok) return { status: "tampered", detail: file.error };
    return compareLedger(file.facts, canonFacts, claim ? this.fact(claim.factId) : null, world.createdAt);
  }

  private async readCanonFile(repoName: string, sha: string): Promise<({ ok: true } & CanonFile) | { ok: false; error: string }> {
    using repo = await this.env.ARTIFACTS.get(repoName);
    const blob = await repo.readFile({ ref: sha, path: "canon.json" });
    if (!blob) return { ok: false, error: "no canon.json at the repo root" };
    try {
      const file = JSON.parse(await blob.text()) as CanonFile;
      if (file.version !== 1 || !Array.isArray(file.facts)) throw new Error('canon.json must be {"version":1,"facts":[...]}');
      for (const f of file.facts) {
        if (!/^[a-z0-9-]{3,48}$/.test(f.id) || typeof f.sentence !== "string") throw new Error(`canon.json fact "${f.id}" needs a slug id and a sentence`);
        validateCheck(f.check);
      }
      return { ok: true, ...file };
    } catch (err) {
      return { ok: false, error: errorStatus(err).message };
    }
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
    status: r.status as Fact["status"],
    proposedBy: r.proposed_by as string | null,
    madeTrueBy: r.made_true_by as string | null,
    createdAt: r.created_at as number,
    acceptedAt: r.accepted_at as number | null,
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
  if (!check || check.kind !== "probe" || !Array.isArray(check.steps) || check.steps.length === 0) {
    throw new ProtocolError(400, 'check must be {"kind":"probe","steps":[...]} with at least one step');
  }
  if (!check.steps.some((s) => s.expect)) throw new ProtocolError(400, "a check with no expectations cannot fail");
  for (const s of check.steps) {
    if (typeof s.path !== "string" || !s.path.startsWith("/")) throw new ProtocolError(400, "every step needs a path starting with /");
  }
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

function shortId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
