// The evaluator's retry rule, checked against a local server:  node scripts/test-probe.ts
// A transient 5xx is retried with a fresh run; a real failure is reported on the first try.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { runCheck, templateNames } from "../referee/src/probe.ts";

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

// Random inputs: a tiny shop with one basket per x-canon-run (visitors share "public"), honest or with a bulk discount.
const PRICES: Record<string, number> = { eggs: 400, kale: 300, "duck-eggs": 650, greens: 450 };
let discount = false;
let seen: Array<{ run?: string; qty?: number }> = [];
const carts = new Map<string, Map<string, number>>();
const shop = createServer(async (req, res) => {
  const run = req.headers["x-canon-run"] as string | undefined;
  const cart = carts.get(run ?? "public") ?? new Map<string, number>();
  carts.set(run ?? "public", cart);
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method === "POST") {
    const { productId, qty } = JSON.parse(body) as { productId: string; qty: number };
    cart.set(productId, (cart.get(productId) ?? 0) + qty);
    seen.push({ run, qty });
  } else seen.push({ run });
  const total = [...cart].reduce((sum, [id, q]) => sum + Math.round(PRICES[id] * q * (discount && q >= 10 ? 0.9 : 1)), 0);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalCents: total }));
});
await new Promise<void>((r) => shop.listen(0, r));
const shopOrigin = `http://127.0.0.1:${(shop.address() as { port: number }).port}`;
const items = (ids: string[]) => ids.map((id) => ({ id, cents: PRICES[id] }));
const listed = {
  kind: "probe" as const,
  samples: 4,
  vars: { a: { oneOf: items(["eggs", "kale"]) }, b: { oneOf: items(["duck-eggs", "greens"]) }, qa: { int: [1, 20] as [number, number] }, qb: { int: [1, 20] as [number, number] } },
  steps: [
    { method: "POST" as const, path: "/api/cart", body: { productId: "{{a.id}}", qty: "{{qa}}" }, expect: { status: 200 } },
    { method: "POST" as const, path: "/api/cart", body: { productId: "{{b.id}}", qty: "{{qb}}" }, expect: { status: 200 } },
    { path: "/api/cart", expect: { status: 200, json: { totalCents: "{{qa * a.cents + qb * b.cents}}" } } },
  ],
};
const qtys = () => seen.filter((x) => x.qty !== undefined).map((x) => x.qty);

seen = [];
r = await runCheck(listed, shopOrigin, "sha1:price-is-listed");
assert.equal(r.held, true, r.detail);
assert.equal(qtys().length, 8);
assert.equal(new Set(seen.map((x) => x.run)).size, 4);
const first = qtys();
console.log(`ok  random inputs, honest shop -> holds over 4 samples, each in its own run (qty ${first.join(", ")})`);

seen = [];
await runCheck(listed, shopOrigin, "sha1:price-is-listed");
assert.deepEqual(qtys(), first);
seen = [];
await runCheck(listed, shopOrigin, "sha2:price-is-listed");
assert.notDeepEqual(qtys(), first);
console.log("ok  same commit and fact      -> the same inputs; another commit draws others");

discount = true;
let caught = 0;
let example = "";
for (let i = 0; i < 300; i++) {
  const res = await runCheck(listed, shopOrigin, `discount-${i}:price-is-listed`);
  if (!res.held) { caught++; example ||= res.detail; }
}
discount = false;
assert.ok(caught >= 296, `caught only ${caught} of 300`);
console.log(`ok  10% off lines of 10+      -> caught on ${caught} of 300 commits (${example})`);

seen = [];
r = await runCheck({ kind: "probe", isolate: false, steps: [{ path: "/api/cart", expect: { status: 200 } }] }, shopOrigin);
assert.equal(r.held, true);
assert.equal(seen[0].run, undefined);
seen = [];
await runCheck({ kind: "probe", steps: [{ path: "/api/cart", expect: { status: 200 } }] }, shopOrigin);
assert.ok(seen[0].run);
console.log("ok  isolate: false            -> sent like a visitor, with no x-canon-run header");

assert.deepEqual(templateNames(listed.steps), ["a", "qa", "b", "qb", "qa", "a", "qb", "b"]);
console.log("ok  templateNames             -> the inputs a check uses, for validation");
shop.close();
