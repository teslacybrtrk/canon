// Who may read what, through the real router and the judge's real methods (harness: real SQLite storage per project).
// A project is private until its owner publishes it: to anyone without a key it doesn't exist, its repository isn't
// served, and publishing needs the owner's key. A public project is read-only to the public.
//   node --import ./scripts/harness/register.mjs scripts/test-access.ts
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { durableObjectState } from "./harness/durable-object.ts";
import { Referee } from "../referee/src/referee.ts";
import worker from "../referee/src/index.ts";
import { timingSafeEqual } from "node:crypto";

// Workers' constant-time compare, which Node's Web Crypto doesn't have.
Object.assign(crypto.subtle, { timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(Buffer.from(a), Buffer.from(b)) });

const ok = (name: string) => console.log(`ok   ${name}`);
const judges = new Map<string, Referee>();
const env = {
  CANON_KEY: "owner-key", CANON_AGENT_KEY: "agent-key", REFEREE_EPOCH: "1", CLOUDFLARE_ACCOUNT_ID: "acct", CF_TOKEN: "token", PRODUCTION_URL: "https://{project}.example",
  ASSETS: { fetch: async () => new Response("page") },
  REFEREE: {
    idFromName: (name: string) => name,
    get: (name: string) => {
      if (!judges.has(name)) {
        const db = new DatabaseSync(":memory:");
        const judge = new Referee(durableObjectState(db) as never, env as never);
        db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', '${name.split("#")[0]}')`);
        judges.set(name, judge);
      }
      return judges.get(name);
    },
  },
};
const call = (method: string, path: string, key?: string, body?: unknown) =>
  worker.fetch(new Request(`https://canon.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env as never, {} as never);

for (const path of ["/p/shop/canon", "/p/shop/ledger", "/p/shop/timeline", "/p/shop/stats", "/p/shop/facts/x/why", "/p/shop/canon/2/acceptance"]) {
  assert.equal((await call("GET", path)).status, 404, path);
}
assert.equal((await call("POST", "/p/shop/facts/x/check")).status, 404);
ok("a project nobody published doesn't exist to the public: board data, ledger, timeline, records, the fact chain, production checks");
assert.equal((await call("GET", "/p/shop/canon", "agent-key")).status, 200);
assert.equal((await call("GET", "/p/shop/ledger", "owner-key")).status, 200);
assert.equal((await call("GET", "/p/shop/canon", "wrong-key")).status, 404);
ok("an agent's key or the owner's key reads it; a wrong key is no key");
for (const path of ["/p/shop.git/info/refs?service=git-upload-pack", "/a/shop-a1b2c3.git/info/refs?service=git-upload-pack", "/w/shop-x9.git/info/refs"]) {
  assert.equal((await call("GET", path)).status, 404, path);
}
ok("its canon and its attempts aren't served over Git to the public");

assert.equal((await call("POST", "/p/shop/visibility", undefined, { public: true })).status, 404);
assert.equal((await call("POST", "/p/shop/visibility", "agent-key", { public: true })).status, 403);
assert.equal((await call("POST", "/p/shop/visibility", "owner-key", { public: "yes" })).status, 400);
const published = await call("POST", "/p/shop/visibility", "owner-key", { public: true });
assert.deepEqual(await published.json(), { project: "shop", public: true });
ok("only the owner's key publishes it (an agent's key can't, and the body must say true or false)");

for (const path of ["/p/shop/canon", "/p/shop/ledger", "/p/shop/timeline", "/p/shop/visibility"]) assert.equal((await call("GET", path)).status, 200, path);
assert.equal((await call("POST", "/p/shop/claims", undefined, { agent: "a", why: "x", fact: { id: "abc", sentence: "s", check: { kind: "probe", steps: [{ path: "/" }] } } })).status, 401);
assert.equal((await call("POST", "/p/shop/claims/c-1/accept")).status, 401);
assert.equal((await call("GET", "/p/shop/heldout")).status, 401);
ok("published, it's read-only to the public: claims, accepts and the held-out checks still need keys");

await call("POST", "/p/shop/visibility", "owner-key", { public: false });
assert.equal((await call("GET", "/p/shop/canon")).status, 404);
ok("the owner can take it back");
assert.equal((await call("GET", "/p/other/canon")).status, 404);
assert.equal((await call("GET", "/a/nodash.git/info/refs")).status, 404);
ok("projects are separate, and a repository name that names no project is refused");
