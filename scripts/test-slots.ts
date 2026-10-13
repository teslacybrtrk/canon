// Account-wide verification capacity: never over the limit, fair between projects, and released slots are reused.
import assert from "node:assert/strict";
import { grantSlot, type SlotState } from "../referee/src/slots.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
let state: SlotState = { slots: {}, waiting: {} };
const ask = (key: string, project: string, now = 1_000) => {
  const r = grantSlot(state, key, project, 3, now);
  state = r.next;
  return r.granted;
};
assert.equal(ask("a1", "alpha"), true);
assert.equal(ask("a2", "alpha"), true);
assert.equal(ask("a3", "alpha"), true);
assert.equal(ask("a4", "alpha"), false);
ok("never more than the account's limit at once");
delete state.slots.a1;
assert.equal(ask("b1", "beta", 2_000), true, "beta has none running, so it goes before alpha's older a4");
assert.equal(ask("a4", "alpha", 2_000), false);
ok("a freed slot goes to the project with the fewest running, even if another project waited longer");
delete state.slots.a2;
assert.equal(ask("a4", "alpha", 3_000), true);
ok("and then to the longest wait");
assert.equal(ask("a4", "alpha", 3_500), true);
ok("asking again with a granted slot keeps it");
state.slots.b1.at = 0;
assert.equal(ask("c1", "gamma", 15 * 60_000 + 10), true);
ok("a slot its project never released expires after 15 minutes");
