// The rollback rehearsal's check, run twice, on the judge's real method (harness: real SQLite storage, a fetch that
// fails the test if it's called). Found in the final autonomous run: the judge restarted mid-call, Workflows ran the
// "check rollback rehearsal" step again, and the second run, finding the fixtures the first had used and deleted, called
// a passed rehearsal unavailable and held a correct release. The first run's verdict must stand.
//   node --import ./scripts/harness/register.mjs scripts/test-judge-rehearsal.ts
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { durableObjectState } from "./harness/durable-object.ts";
import { Referee } from "../referee/src/referee.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
globalThis.fetch = (async () => { throw new Error("a rehearsal that already ran must not send a request"); }) as typeof fetch;
const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CF_TOKEN: "token", PRODUCTION_URL: "https://{project}.example", CANDIDATE_URL: "https://{project}-candidate.example", REFEREE_EPOCH: "1" };

function judgeWith(rehearsal: { state: string; detail: string }, rollbackSafe: boolean, authorizedBy: string) {
  const db = new DatabaseSync(":memory:");
  const judge = new Referee(durableObjectState(db) as never, env as never) as unknown as Record<string, (...a: unknown[]) => Promise<unknown> | unknown>;
  const now = Date.now();
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', 'shop')`);
  db.exec(`INSERT INTO canon (seq, attempt_id, sha, accepted_fact, deployed, at) VALUES (1, 'shop-genesis', 'g1', NULL, 1, ${now}), (2, 'shop-a1', 'a2', 'bulk', 0, ${now})`);
  const record = { canonSeq: 2, sha: "a2", attemptId: "shop-a1", judgedOnCanon: 1, facts: [], verdict: { kept: 0, skipped: 0, previewUrl: "", judgedAt: now }, environment: "", authorizedBy, exceptions: [], policy: { autoAccept: "backlog", charter: {}, version: "v" }, recovery: { rehearse: true, rollbackSafe, how: "", rehearsal: { ...rehearsal, at: now } }, at: now };
  db.exec(`INSERT INTO acceptances (seq, sha, json) VALUES (2, 'a2', '${JSON.stringify(record).replace(/'/g, "''")}')`);
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('releaseLease', '${JSON.stringify({ seq: 2, sha: "a2", holder: "promote-2-x", until: now + 600_000 })}')`);
  return { judge, db };
}

{
  const { judge, db } = judgeWith({ state: "passed", detail: "the previous version kept all 6 of its facts [2 compared]" }, true, "autopilot");
  assert.equal(await judge.rehearsalCheck(2, "promote-2-x", true, ""), true);
  const health = db.prepare(`SELECT health FROM canon WHERE seq = 2`).get() as { health: string | null };
  assert.equal(health.health, null);
  ok("asked again after a rehearsal passed, the judge answers the same (release goes on) without re-running it");
}
{
  const { judge, db } = judgeWith({ state: "failed", detail: "the previous version broke “cart-starts-empty”" }, false, "autopilot: the backlog");
  assert.equal(await judge.rehearsalCheck(2, "promote-2-x", true, ""), false);
  assert.equal((db.prepare(`SELECT health FROM canon WHERE seq = 2`).get() as { health: string }).health, "held");
  ok("asked again after a rehearsal failed on autopilot, it still holds the release, and says so");
}
{
  const { judge } = judgeWith({ state: "unavailable", detail: "no read-back" }, false, "the owner");
  assert.equal(await judge.rehearsalCheck(2, "promote-2-x", true, ""), true);
  assert.match(String(((await judge.acceptance(2)) as { recovery: { override?: string } }).recovery.override), /released on the owner's authority although its rollback rehearsal unavailable/);
  ok("an owner's accept still goes out over a rehearsal that couldn't establish safety, and the record names the override");
}
{
  const { judge } = judgeWith({ state: "passed", detail: "x" }, true, "autopilot");
  assert.equal(await judge.rehearsalCheck(2, "someone-else", true, ""), false);
  ok("a run that doesn't hold the release's lease gets no answer but no");
}
