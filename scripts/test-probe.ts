// The evaluator's retry rule, checked against a local server:  node scripts/test-probe.ts
// A transient 5xx is retried with a fresh run; a real failure is reported on the first try.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { runCheck } from "../referee/src/probe.ts";

let hits = 0;
let failFirst = 0;
const server = createServer((req, res) => {
  hits++;
  if (failFirst > 0) {
    failFirst--;
    res.writeHead(500).end("warming up");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalCents: 4800 }));
});
await new Promise<void>((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const check = (total: number) => ({ kind: "probe" as const, steps: [{ path: "/api/cart", expect: { status: 200, json: { totalCents: total } } }] });

failFirst = 2; hits = 0;
let r = await runCheck(check(4800), origin);
assert.equal(r.held, true); assert.equal(hits, 3);
console.log("ok  two 500s then 200     -> holds after 3 requests");

failFirst = 5; hits = 0;
r = await runCheck(check(4800), origin);
assert.equal(r.held, false); assert.equal(hits, 3);
console.log(`ok  500 every time        -> fails after 3 requests (${r.detail})`);

failFirst = 0; hits = 0;
r = await runCheck(check(4320), origin);
assert.equal(r.held, false); assert.equal(hits, 1);
console.log(`ok  wrong value           -> fails on the first request (${r.detail})`);
server.close();

// Latency budget: one warm-up, then `repeat` timed requests; p95 must fit.
let delay = 0;
const slow = createServer((req, res) => setTimeout(() => res.writeHead(200).end("ok"), delay));
await new Promise<void>((r) => slow.listen(0, r));
const slowOrigin = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
const budget = { kind: "probe" as const, steps: [{ path: "/", repeat: 10, expect: { status: 200, p95Ms: 150 } }] };
delay = 5;
r = await runCheck(budget, slowOrigin);
assert.equal(r.held, true);
console.log("ok  fast responses          -> within the p95 budget");
delay = 250;
r = await runCheck(budget, slowOrigin);
assert.equal(r.held, false);
console.log(`ok  slow responses          -> over budget (${r.detail})`);
slow.close();
