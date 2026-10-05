import { CiSandbox } from "@cloudflare/ci/worker";
import type { Env } from "./env";
import { errorStatus, type DeclareRequest } from "./protocol";
import { serveMcp } from "./mcp";
import { serveGit, serveSource } from "./source";
import { refereeForProject } from "./stub";

export { CiSandbox };
export { Referee } from "./referee";
export { VerifyWorld, PromoteWorld } from "./pipelines";

// The Canon HTTP surface. Reads are public. Writes need a bearer key: the owner's key (CANON_KEY)
// can do anything, an agent's key (CANON_AGENT_KEY) can only declare. Running a fact's check
// against production stays open, since it changes nothing in canon.
//
//   GET  /p/:project/canon                    move 1: read
//   POST /p/:project/claims                   move 2: declare  (fork + token)        agent or owner key
//        git push <remote> main               move 3: push     (plain Git)
//   GET  /p/:project/worlds/:id/verdict       move 4: verdict
//   POST /p/:project/claims/:id/accept        review: a human accepts a fact          owner key
//   GET  /p/:project/facts/:id/why            the fact chain
//   POST /p/:project/facts/:id/check          run a fact's check against production now
//   GET  /p/:project/ws                       live board
//   GET  /p/:project/previews                 Preview names used (for reset)
//   POST /p/:project/mcp                      the moves as MCP tools, for any MCP agent        agent or owner key
//   git clone https://canon.rodeo/canon.git   Canon's own source, read-only (also /w/<world>.git, /src)
//   POST /p/:project/genesis                  one-time setup (empty repo, or {"importUrl": "<git url>"})   owner key
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/meta") return json({ sourcePublic: env.SOURCE_PUBLIC === "true" });
    const served = (await serveGit(request, env)) ?? (await serveSource(request, env));
    if (served) return served;
    const m = url.pathname.match(/^\/p\/([a-z0-9]+)(\/.*)$/);
    if (!m) return env.ASSETS.fetch(request);
    const [, project, rest] = m;
    const referee = refereeForProject(env, project);
    const route = `${request.method} ${rest}`;

    // Every POST is a write and needs a key, except checking a fact against production.
    if (request.method === "POST" && !/^POST \/facts\/[\w-]+\/check$/.test(route)) {
      const denied = await deny(request, env, route === "POST /claims" || route === "POST /mcp" ? "agent" : "owner");
      if (denied) return denied;
    }

    try {
      let match: RegExpMatchArray | null;
      if (rest === "/mcp") return serveMcp(request, env, project);
      if (route === "GET /ws") return referee.fetch(request);
      if (route === "GET /canon") return json(await referee.read());
      if (route === "GET /previews") return json(await referee.previews());
      if (route === "POST /genesis") {
        const body = await request.json<{ importUrl?: string }>().catch(() => ({}) as { importUrl?: string });
        return json(await referee.genesis(project, body.importUrl), 201);
      }
      if (route === "POST /claims") return json(await referee.declare(await request.json<DeclareRequest>()), 201);
      if ((match = route.match(/^GET \/worlds\/([\w-]+)\/verdict$/))) {
        const verdict = await referee.verdict(match[1]);
        return verdict ? json(verdict) : json({ outcome: "pending" }, 202);
      }
      if ((match = route.match(/^POST \/claims\/([\w-]+)\/accept$/))) return json(await referee.accept(match[1]));
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
