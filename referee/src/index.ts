import { CiSandbox } from "@cloudflare/ci/worker";
import type { Env } from "./env";
import { errorStatus, type DeclareRequest } from "./protocol";
import { serveGit, serveSource } from "./source";
import { refereeForProject } from "./stub";

export { CiSandbox };
export { Referee } from "./referee";
export { VerifyWorld, PromoteWorld } from "./pipelines";

// The Canon HTTP surface. No auth by design for the demo: put the Worker behind
// Cloudflare Access before exposing it, since `declare` hands out write tokens.
//
//   GET  /p/:project/canon                    move 1: read
//   POST /p/:project/claims                   move 2: declare  (fork + token)
//        git push <remote> main               move 3: push     (plain Git)
//   GET  /p/:project/worlds/:id/verdict       move 4: verdict
//   POST /p/:project/claims/:id/accept        review: a human accepts a fact
//   GET  /p/:project/facts/:id/why            the fact chain
//   POST /p/:project/facts/:id/check          run a fact's check against production now
//   GET  /p/:project/ws                       live board
//   GET  /p/:project/previews                 Preview names used (for reset)
//   git clone https://canon.rodeo/canon.git   Canon's own source, read-only (also /w/<world>.git, /src)
//   POST /p/:project/genesis                  one-time setup (empty repo, or {"importUrl": "<git url>"})
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

    try {
      let match: RegExpMatchArray | null;
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
