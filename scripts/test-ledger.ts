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
  ["key order differs", [...seed.map((f: any) => ({ check: f.check, sentence: f.sentence, id: f.id })), claimed], undefined, "ok"],
  ["canon moved after fork", [...seed, claimed], [...seed, { ...clone(seed[0]), id: "sold-out-refused", acceptedAt: 300 }], "behind"],
];
for (const [name, file, canon, want] of cases) {
  const got = status(file, canon);
  assert.equal(got.status, want, `${name}: ${got.detail}`);
  console.log(`ok  ${name.padEnd(24)} -> ${got.status}${got.status === "ok" ? "" : `: ${got.detail}`}`);
}
