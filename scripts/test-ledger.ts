// The canon.json rules, checked without Cloudflare:  node scripts/test-ledger.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { compareLedger } from "../referee/src/ledger.ts";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const seed = read("../demo-app/canon.json").facts.map((f: any) => ({ ...f, acceptedAt: 100 }));
const claimed = read("../agents/claims/no-double-booking.json");
const forkedAt = 200;
const clone = (x: unknown) => JSON.parse(JSON.stringify(x));
const status = (file: any[], canon = seed) => compareLedger(file, canon, claimed, forkedAt);

const cases: Array<[string, any[], any[] | undefined, string]> = [
  ["canon + claimed fact", [...seed, claimed], undefined, "ok"],
  ["claimed fact missing", seed, undefined, "tampered"],
  ["weakened check", [...seed.map((f: any, i: number) => (i === 3 ? { ...clone(f), check: { kind: "probe", steps: [{ path: "/", expect: { status: 200 } }] } } : f)), claimed], undefined, "tampered"],
  ["drops a canon fact", [...seed.slice(1), claimed], undefined, "tampered"],
  ["invents an extra fact", [...seed, claimed, { ...clone(claimed), id: "free-honey" }], undefined, "tampered"],
  ["key order differs", [...seed.map((f: any) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "acceptedAt").reverse())), claimed], undefined, "ok"],
  ["scope removed", [...seed.map((f: any) => { const { scope, ...rest } = f; return rest; }), claimed], undefined, seed.some((f: any) => f.scope) ? "tampered" : "ok"],
  ["canon moved after fork", [...seed, claimed], [...seed, { ...clone(seed[0]), id: "sold-out-refused", acceptedAt: 300 }], "behind"],
];
// Revisions and retirement.
const revision = { ...clone(claimed), id: "price-with-bulk-discount", replaces: "price-is-listed" };
const withoutPrice = seed.filter((f: any) => f.id !== "price-is-listed");
const rev = (file: any[]) => compareLedger(file, seed, revision, forkedAt, { retiring: "price-is-listed" });
assert.equal(rev([...withoutPrice, revision]).status, "ok");
console.log("ok  revision drops the fact it replaces -> ok");
assert.equal(rev([...withoutPrice]).status, "tampered");
console.log("ok  revision missing its new fact      -> tampered");
assert.equal(compareLedger([...withoutPrice, claimed], seed, claimed, forkedAt).status, "tampered");
console.log("ok  dropping a fact without a revision -> tampered");
const retired = [{ ...seed.find((f: any) => f.id === "price-is-listed"), retiredAt: 300 }];
const afterRetire = [...withoutPrice, { ...revision, acceptedAt: 300 }];
assert.equal(compareLedger([...seed, claimed], afterRetire, claimed, forkedAt, { retired }).status, "behind");
console.log("ok  fact retired after the fork        -> behind");

for (const [name, file, canon, want] of cases) {
  const got = status(file, canon);
  assert.equal(got.status, want, `${name}: ${got.detail}`);
  console.log(`ok  ${name.padEnd(24)} -> ${got.status}${got.status === "ok" ? "" : `: ${got.detail}`}`);
}
