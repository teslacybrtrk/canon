import { CiSandbox } from "@cloudflare/ci/worker";
import type { Env } from "./env";
import { errorStatus, type DeclareRequest, type FactDef } from "./protocol";
import { serveMcp } from "./mcp";
import { serveGit, serveSource } from "./source";
import { refereeForProject } from "./stub";

export { CiSandbox };
export { Referee } from "./referee";
export { Capacity } from "./capacity";
export { VerifyAttempt, PromoteAttempt, RefreshAttempt, TrainAttempt, MutateAttempt } from "./pipelines";

// The Canon HTTP surface. A project's reads are public only once its owner publishes it (POST /visibility); until then
// they need a key, like writes, and to anyone without one the project doesn't exist. Writes need a bearer key: the
// owner's key (CANON_KEY) can do anything, an agent's key (CANON_AGENT_KEY) can only declare. Running a fact's check
// against production needs no key on a public project, since it changes nothing in canon.
//
//   GET  /p/:project/canon                    move 1: read
//   POST /p/:project/claims                   move 2: declare  (fork + token)        agent or owner key
//        git push <remote> main               move 3: push     (plain Git)
//   GET  /p/:project/attempts/:id/verdict       move 4: verdict
//   POST /p/:project/heldout                  {id, sentence, check}: a fact agents can't see the check of    owner key
//   GET  /p/:project/heldout                  the held-out facts in full                                 owner key
//   GET  /p/:project/canon/:seq/acceptance      what canon #seq authorized, on what evidence, under which policy
//   POST /p/:project/claims/:id/accept        review: a human accepts a fact          owner key
//   POST /p/:project/claims/:id/decline       review: a human says no ({"reason"})    owner key
//   GET  /p/:project/facts/:id/why            the fact chain
//   POST /p/:project/facts/:id/check          run a fact's check against production now
//   GET  /p/:project/ws                       live board
//   GET  /p/:project/previews                 Preview names used (for reset)
//   GET  /p/:project/stats                    the run report: counts and push-to-verdict times
//   GET  /p/:project/ledger                   every feature from the request to production, with its evidence
//   GET  /p/:project/timeline                 the run as it happened, event by event (for replaying a recorded run)
//   POST /p/:project/visibility               {"public": true}: anyone may read it (read-only); false takes it back   owner key
//   POST /p/:project/republish                redeploy canon and rewrite its Git notes                owner key
//   POST /p/:project/reconcile                canon = production now: revert a canon that wasn't released   owner key
//   POST /p/:project/attempts/:id/review      run the advisory reviewer again on the attempt's latest commit  owner key
//   POST /p/:project/overlaps                  {attempt, paths}: other attempts in flight changing the same files   agent key
//   POST /p/:project/mcp                      the moves as MCP tools, for any MCP agent        agent or owner key
//   git clone https://canon.rodeo/canon.git   Canon's own source, read-only (also /a/<attempt>.git, /src)
//   POST /p/:project/genesis                  one-time setup (empty repo, or {"importUrl": "<git url>"})   owner key
//   GET  /video/:name                         the demo video, from R2 (ranges, so players can seek)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The demo is the board page, run in the browser on sample data (it reads its own path).
    if (url.pathname === "/demo") return env.ASSETS.fetch(new Request(new URL("/board", url), request));
    if (url.pathname === "/meta") return json({ sourcePublic: env.SOURCE_PUBLIC === "true" });
    if (url.pathname.startsWith("/video/")) return serveVideo(request, env, url.pathname.slice("/video/".length));
    const served = (await serveGit(request, env)) ?? (await serveSource(request, env));
    if (served) return served;
    const m = url.pathname.match(/^\/p\/([a-z0-9]+)(\/.*)$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, project, rest] = m;
    const referee = refereeForProject(env, project);
    const route = `${request.method} ${rest}`;

    // A project its owner hasn't published answers only to a key (an agent's or the owner's); to anyone else it doesn't
    // exist. Genesis creates the project, so it's let through to its own owner-key check below.
    if (route !== "POST /genesis") {
      // Right after a deploy a busy project's judge can still be on the old code for a moment.
      const open = await Promise.resolve(referee.isPublic()).catch(() => null);
      if (open === null) return json({ error: "this project's judge is restarting; try again in a moment" }, 503);
      if (!open && (await deny(request, env, "agent"))) return json({ error: "no such public project" }, 404);
    }

    // Every POST is a write and needs a key, except checking a fact against production.
    if (request.method === "POST" && !/^POST \/facts\/[\w-]+\/check$/.test(route)) {
      const denied = await deny(request, env, route === "POST /claims" || route === "POST /mcp" || route === "POST /overlaps" ? "agent" : "owner");
      if (denied) return denied;
    }

    try {
      let match: RegExpMatchArray | null;
      if (rest === "/mcp") return await serveMcp(request, env, project);
      if (route === "GET /ws") return referee.fetch(request);
      if (route === "GET /canon") return json(await referee.read());
      if (route === "GET /previews") return json(await referee.previews());
      if (route === "GET /stats") return json(await referee.stats());
      if (route === "GET /ledger") return json(await referee.ledger());
      if (route === "GET /timeline") return json(await referee.timeline());
      if (route === "GET /visibility") return json({ project, public: await referee.isPublic() });
      if (route === "POST /visibility") {
        const body = await request.json<{ public?: unknown }>().catch(() => ({}) as { public?: unknown });
        if (typeof body.public !== "boolean") return json({ error: 'send {"public": true} or {"public": false}' }, 400);
        return json(await referee.setPublic(body.public));
      }
      // Held-out facts: the owner writes them into the judge and reads them back; agents see only their sentences.
      if (route === "POST /repair") {
        const b = await request.json<{ path?: string; conflicted?: string; intents?: string[] }>().catch(() => ({}) as { path?: string; conflicted?: string; intents?: string[] });
        return json(await referee.repairText(String(b.path ?? ""), String(b.conflicted ?? ""), Array.isArray(b.intents) ? b.intents.map(String) : []));
      }
      if (route === "POST /heldout") return json(await referee.addHeldOut(await request.json<FactDef>()), 201);
      if (route === "GET /heldout") {
        const denied = await deny(request, env, "owner");
        if (denied) return denied;
        return json(await referee.heldOut());
      }
      if ((match = route.match(/^GET \/canon\/(\d+)\/acceptance$/))) {
        const record = await referee.acceptanceView(Number(match[1]));
        return record ? json(record) : json({ error: "no acceptance record (genesis, or accepted before records existed)" }, 404);
      }
      if (route === "POST /republish") return json(await referee.republish(), 202);
      if (route === "POST /reconcile") return json(await referee.reconcile());
      if (route === "POST /genesis") {
        const body = await request.json<{ importUrl?: string }>().catch(() => ({}) as { importUrl?: string });
        return json(await referee.genesis(project, body.importUrl), 201);
      }
      if (route === "POST /claims") return json(await referee.declare(await request.json<DeclareRequest>()), 201);
      if (route === "POST /overlaps") {
        const body = await request.json<{ attempt?: string; paths?: string[]; files?: Record<string, string> }>().catch(() => ({}) as { attempt?: string; paths?: string[]; files?: Record<string, string> });
        const files = body.files && typeof body.files === "object" ? body.files : {};
        return json(await referee.overlaps(String(body.attempt ?? ""), Array.isArray(body.paths) ? body.paths : [], files));
      }
      if ((match = route.match(/^GET \/attempts\/([\w-]+)\/verdict$/))) {
        const verdict = await referee.verdict(match[1]);
        return verdict ? json(verdict) : json({ outcome: "pending" }, 202);
      }
      if ((match = route.match(/^POST \/attempts\/([\w-]+)\/review$/))) return json(await referee.reReview(match[1]));
      if ((match = route.match(/^POST \/claims\/([\w-]+)\/accept$/))) {
        // Optional {"reason": "..."}: why this attempt, in the owner's words; the acceptance record keeps it.
        const body = await request.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
        return json(await referee.accept(match[1], "the owner", typeof body.reason === "string" ? body.reason : undefined));
      }
      if ((match = route.match(/^POST \/claims\/([\w-]+)\/decline$/))) {
        const body = await request.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
        return json(await referee.decline(match[1], body.reason));
      }
      if ((match = route.match(/^GET \/facts\/([\w-]+)\/why$/))) return json(await referee.why(match[1]));
      if ((match = route.match(/^POST \/facts\/([\w-]+)\/check$/))) return json(await referee.checkProduction(match[1]));
      return json({ error: "not found" }, 404);
    } catch (err) {
      const { status, message } = errorStatus(err);
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

// Null when the request's key may do this write. The owner's key may do any write; an agent's key may only declare.
async function deny(request: Request, env: Env, need: "owner" | "agent"): Promise<Response | null> {
  if (!env.CANON_KEY) return json({ error: "writes are off: this referee has no CANON_KEY secret yet" }, 503);
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (await same(key, env.CANON_KEY)) return null;
  const agent = await same(key, env.CANON_AGENT_KEY);
  if (agent && need === "agent") return null;
  if (agent) return json({ error: "an agent's key can only claim; this needs the owner's key" }, 403);
  return json({ error: "writing needs a key: send Authorization: Bearer <key>" }, 401);
}

// Compares SHA-256 hashes in constant time, so neither the key nor its length leaks through timing.
async function same(given: string, key: string | undefined) {
  if (!given || !key) return false;
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all([given, key].map((s) => crypto.subtle.digest("SHA-256", bytes.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The demo video from R2. Range requests get 206 with the slice, so a <video> player can seek without the whole file. */
async function serveVideo(request: Request, env: Env, name: string): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method) || !/^[\w-]+\.mp4$/.test(name)) return new Response("not found", { status: 404 });
  if (!env.MEDIA) return new Response("not found", { status: 404 });
  const object = await env.MEDIA.get(name, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({ "accept-ranges": "bytes", etag: object.httpEtag, "cache-control": "public, max-age=86400" });
  object.writeHttpMetadata(headers);
  if (!("body" in object)) return new Response(null, { status: 304, headers }); // the browser's copy is current
  const range = object.range as { offset?: number; length?: number } | undefined;
  if (range && request.headers.has("range")) {
    const offset = range.offset ?? 0, length = range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
