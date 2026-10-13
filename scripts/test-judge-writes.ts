// Method-level ordering tests for production deployment writes: the judge's real restoreProduction, rollBack, fence and
// gate, on real SQLite storage, with the Cloudflare deployments API replaced by requests this test answers by hand (in
// either order, or never). Run with the harness: node --import ./scripts/harness/register.mjs scripts/test-judge-writes.ts
// JUDGE_SRC=<path to referee.ts> runs the same scenarios against another version (to show the bug before the fix).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { durableObjectState } from "./harness/durable-object.ts";

const SRC = process.env.JUDGE_SRC ?? new URL("../referee/src/referee.ts", import.meta.url).href;
const { Referee } = (await import(SRC)) as { Referee: new (ctx: unknown, env: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>> };
const ok = (name: string) => console.log(`ok   ${name}`);

// ---- The deployments API, answered by hand -----------------------------------------------------------------------
type Pending = { version: string; answer: (status?: number) => void; fail: () => void; answered: boolean };
let posts: Pending[] = [];
const log: string[] = [];
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (!String(url).includes("/deployments")) throw new Error(`unexpected fetch ${url}`);
  if ((init?.method ?? "GET") === "GET") return Response.json({ result: { deployments: [{ versions: [{ version_id: "v-live", percentage: 100 }] }] } });
  const version = JSON.parse(String(init!.body)).versions[0].version_id as string;
  log.push(`sent ${version}`);
  return new Promise<Response>((resolve, reject) => {
    const p: Pending = {
      version,
      answered: false,
      answer: (status = 200) => { p.answered = true; log.push(`answered ${version}`); resolve(Response.json({ success: status < 300 }, { status })); },
      fail: () => { p.answered = true; log.push(`unknown ${version}`); reject(new Error("The operation was aborted due to timeout")); },
    };
    posts.push(p);
  });
}) as typeof fetch;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CF_TOKEN: "token", PRODUCTION_URL: "https://{project}.example", REFEREE_EPOCH: "1" };

// A project whose canon #1 is released as v-old; `accept()` adds canon #2 (sha b2), accepted and not yet released.
function project(db = new DatabaseSync(":memory:")) {
  const judge = new Referee(durableObjectState(db), env);
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', 'shop')`);
  db.exec(`INSERT INTO canon (seq, attempt_id, sha, accepted_fact, deployed, at, version_id) VALUES (1, 'shop-a', 'a1', 'f1', 1, ${realNow() - 3_600_000}, 'v-old')`);
  const accept = () => {
    db.exec(`INSERT INTO canon (seq, attempt_id, sha, accepted_fact, deployed, at) VALUES (2, 'shop-b', 'b2', 'f2', 0, ${Date.now()})`);
    db.exec(`INSERT INTO acceptances (seq, sha, json) VALUES (2, 'b2', '{"sha":"b2"}')`);
  };
  return { judge, db, accept };
}
const reset = () => { posts = []; log.length = 0; skew = 0; };
// When did the fence say go, relative to the judge's writes?
async function fenceAfter(judge: Record<string, (...a: unknown[]) => Promise<unknown>>) {
  let granted = false;
  const f = judge.fence(2, "b2", "promote-2-b2").then((r) => { granted = true; log.push(`fence ${(r as { go: boolean }).go ? "go" : "refused"}`); return r; });
  return { f, granted: () => granted };
}

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); ok(name); } catch (e) { failures++; console.log(`FAIL ${name}: ${(e as Error).message}`); } };

// 1. Two overlapping restores (the reviewer's reproduction): the first answers; a release is accepted and its run asks
//    the fence. It must not get permission while the second old-version write can still land.
{
  reset();
  const { judge, accept } = project();
  const r1 = judge.restoreProduction("drift 1").catch(() => {});
  const r2 = judge.restoreProduction("drift 2").catch(() => {});
  await tick();
  check("overlapping restores: the second judge write isn't sent while the first is outstanding (serialized)", () => assert.equal(posts.length, 1, log.join(", ")));
  posts[0].answer();
  await tick(1_200);
  const second = posts[1];
  accept();
  const fence = await fenceAfter(judge);
  await tick(1_200);
  check("the first write's answer doesn't let a release through while the second is outstanding", () => assert.equal(fence.granted(), false, log.join(", ")));
  second?.answer();
  await fence.f;
  await Promise.all([r1, r2]);
  check("the fence grants only after every judge write is answered: old, old, then the release", () => assert.deepEqual(log.filter((l) => /^(answered|fence)/.test(l)), ["answered v-old", "answered v-old", "fence go"]));
}

// 2. Responses in the other order: a write still on the wire is never cleared by another write's answer. (With writes
//    serialized only one is on the wire; this checks that an answer settles only its own registration.)
{
  reset();
  const { judge, db, accept } = project();
  const r1 = judge.restoreProduction("drift").catch(() => {});
  await tick();
  // A write registered by an earlier incarnation of this judge (still outstanding, by its own id).
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('judgeWrites', '${JSON.stringify({ ...JSON.parse(String((db.prepare(`SELECT value FROM meta WHERE key = 'judgeWrites'`).get() as { value?: string } | undefined)?.value ?? "{}")), other: Date.now() + 60_000 })}')`);
  posts[0]?.answer();
  await r1;
  accept();
  const fence = await fenceAfter(judge);
  await tick(1_200);
  check("an answer settles only its own write: another outstanding write still holds the fence", () => assert.equal(fence.granted(), false, log.join(", ")));
  skew += 61_000;
  await fence.f;
  check("and the fence goes once that write's window has passed", () => assert.equal(fence.granted(), true));
}

// 3. An unknown outcome followed by a successful write: the success doesn't clear the unknown write's quarantine.
{
  reset();
  const { judge, accept } = project();
  const r1 = judge.restoreProduction("drift 1").catch(() => {});
  await tick();
  posts[0].fail(); // a timeout: it may still land
  await r1;
  const r2 = judge.restoreProduction("drift 2").catch(() => {});
  await tick(1_200);
  check("after an unknown outcome, the next judge write waits out the quarantine before it is sent", () => assert.equal(posts.length, 1, log.join(", ")));
  skew += 121_000;
  await tick(1_200);
  posts[1]?.answer();
  await r2;
  accept();
  skew -= 121_000; // back in time: the unknown write's quarantine would still be running
  const fence = await fenceAfter(judge);
  await tick(1_200);
  check("a later write's success never lifts an earlier unknown write's quarantine", () => assert.equal(fence.granted(), false, log.join(", ")));
  skew += 121_000;
  await fence.f;
}

// 4. A restore overlapping a rollback: both judge writes, serialized the same way.
{
  reset();
  const { judge, db } = project();
  db.exec(`UPDATE canon SET health = 'healthy' WHERE seq = 1`);
  db.exec(`INSERT INTO canon (seq, attempt_id, sha, accepted_fact, deployed, at, version_id) VALUES (2, 'shop-b', 'b2', 'f2', 1, ${Date.now()}, 'v-new')`);
  db.exec(`UPDATE canon SET version_id = 'v-old' WHERE seq = 1`);
  const live = (db.prepare(`SELECT * FROM canon WHERE seq = 2`).get()) as Record<string, unknown>;
  const r = judge.restoreProduction("drift").catch(() => {});
  const b = judge.rollBack(live, "broke a fact").catch(() => {});
  await tick();
  check("a rollback started during a restore waits for it", () => assert.equal(posts.length, 1, log.join(", ")));
  posts[0].answer();
  await tick(1_200);
  check("then goes out, one judge write at a time", () => assert.equal(posts.length, 2, log.join(", ")));
  posts[1]?.answer();
  await Promise.all([r, b]);
}

// 5. Persisted across a judge restart: a write registered by the old instance holds the new instance's fence and gate.
{
  reset();
  const db = new DatabaseSync(":memory:");
  const first = project(db);
  const r1 = first.judge.restoreProduction("drift").catch(() => {});
  await tick();
  // The judge is evicted with the write on the wire; a new instance starts on the same storage.
  const second = new Referee(durableObjectState(db), env);
  first.accept();
  const fence = await fenceAfter(second);
  await tick(1_200);
  check("after a restart, the new judge's fence still waits for a write the old one sent", () => assert.equal(fence.granted(), false, log.join(", ")));
  // The old instance never records an answer (it's gone): only the write's full window ends its protection.
  skew += 141_000;
  await fence.f;
  check("and goes once that write's full window has passed (sending window plus quarantine)", () => assert.equal(fence.granted(), true));
  void r1;
  // The gate's own writes obey the same barrier (direct deploys go through the fence, checked above).
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('judgeWrites', '${JSON.stringify({ x: Date.now() + 60_000 })}')`);
  const before = posts.length;
  const g = second.gate(2, "v-new", "promote-2-b2", false).catch(() => {});
  await tick(1_200);
  check("the gate's production write waits for an outstanding judge write", () => assert.equal(posts.length, before, log.join(", ")));
  skew += 61_000;
  await tick(1_200);
  posts[before]?.answer();
  await g;
  check("and then writes", () => assert.equal(posts.length, before + 1));
}

Date.now = realNow;
if (failures) {
  console.log(`${failures} ordering check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
