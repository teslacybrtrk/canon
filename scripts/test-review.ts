// The reviewer's pure parts: which lines a change added, and that only notes quoting real code survive.
import assert from "node:assert/strict";
import { addedLines, fileBlock, ground, judgeAnswer, parseAnswer, reviewBatches, reviewPrompt, specialistsFor } from "../referee/src/review.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const base = "a\nb\nreturn x;\n";
const head = "a\nif (!x) return 400;\nb\nreturn x;\nreturn x;\n";

assert.deepEqual(addedLines(base, head), [{ n: 2, text: "if (!x) return 400;" }, { n: 5, text: "return x;" }]);
ok("added lines count repeats, and number lines from 1");

const files = [{ path: "src/index.ts", base, head }];
const g = ground(
  {
    notes: [
      { file: "src/index.ts", line: 9, quote: "if (!x)   return 400;", kind: "untested", note: "no fact checks the 400" },
      { file: "src/index.ts", line: 2, quote: "db.delete(everything)", kind: "risk", note: "made up" },
      { file: "src/other.ts", line: 1, quote: "return x;", kind: "risk", note: "wrong file" },
      { file: "src/index.ts", line: 2, quote: "return x;", kind: "style", note: "bad kind" },
    ],
  },
  files,
);
assert.equal(g.notes.length, 1);
assert.equal(g.notes[0].line, 2);
assert.equal(g.notes[0].quote, "if (!x) return 400;");
assert.equal(g.dropped, 3); // the invented quote, the wrong file and the bad kind
ok("a note survives only if its quote is in the file, at the nearest matching line");

assert.equal(g.droppedRisk, true);
assert.deepEqual(ground("not json", files), { notes: [], dropped: 0, droppedRisk: false });
ok("a malformed answer yields no notes");

const p = reviewPrompt("A stall cannot be double-booked", ["The market page lists every stall"], ["removed the guard in src/index.ts:2"], files);
assert.match(p[0].content, /did not write it/);
assert.match(p[1].content, /no fact caught/);
assert.match(p[1].content, /2: if \(!x\) return 400;/);
ok("the prompt carries the claim, the kept facts, the uncaught breaks and the added lines");

assert.deepEqual(parseAnswer('Here you go:\n```json\n{"notes": []}\n```'), { notes: [] });
assert.deepEqual(parseAnswer({ notes: [] }), { notes: [] });
assert.equal(parseAnswer("no json here"), null);
ok("answers parse from an object, a JSON string, or JSON inside prose");

// Only a complete answer in the notes format is a review; anything else is an error, never "no risk".
assert.deepEqual(judgeAnswer('{"notes": []}', "stop", files), { ok: true, notes: [], dropped: 0 });
ok("an empty list of notes is a finding: nothing to flag");
for (const [answer, finish, why] of [
  ["", "stop", "an empty answer"],
  ["I looked at it and it seems fine.", "stop", "prose with no notes"],
  ['{"summary": "fine"}', "stop", "JSON without a notes list"],
  ['{"notes": [', "length", "an answer cut off"],
  ['{"notes": []}', "length", "even a parseable answer that ran out of room"],
  [null, undefined, "no answer at all"],
] as const) {
  const j = judgeAnswer(answer, finish, files);
  assert.equal(j.ok, false, why);
}
ok("empty, prose-only, wrong-shape, cut-off or missing answers are errors (unavailable), not passes");
const invented = judgeAnswer({ notes: [{ file: "src/index.ts", line: 2, quote: "db.delete(everything)", kind: "risk", note: "made up" }] }, "stop", files);
assert.equal(invented.ok, false);
ok("a risk the model can't quote from the code makes the review unusable, not clean");
const many = ground({ notes: [1, 2, 3].map(() => ({ file: "src/index.ts", line: 4, quote: "return x;", kind: "untested", note: "n" })).concat([{ file: "src/index.ts", line: 2, quote: "if (!x) return 400;", kind: "risk", note: "r" }]) }, files);
assert.equal(many.notes.length, 3);
assert.equal(many.notes[0].kind, "risk");
ok("a risk is kept even after three other notes (risks first)");

// Every entry must be a whole note: one malformed entry makes the answer unusable, not quietly emptier.
for (const notes of [[{}], [null], ["risk"], [{ file: "src/index.ts", line: "2", quote: "return x;", kind: "untested", note: "n" }], [{ file: "src/index.ts", line: 2, quote: "return x;", kind: "style", note: "n" }], [{ file: "src/index.ts", line: 2, quote: "return x;", kind: "untested", note: "" }]]) {
  assert.equal(judgeAnswer({ notes }, "stop", files).ok, false, JSON.stringify(notes));
}
ok('{"notes":[{}]} and other malformed entries are errors (unavailable), never a clean review');

// Coverage: nothing is cut off. Files are packed into passes that fit, a big file is shown around each change, and a
// file too big even that way can't be reviewed.
const fileOf = (path: string, n: number, changeAt: number[]) => {
  const base = Array.from({ length: n }, (_, i) => `const v${i} = ${i}; // ${"x".repeat(40)}`).join("\n");
  const head = base.split("\n").map((l, i) => (changeAt.includes(i) ? `${l}\nif (v${i} > 1) throw new Error("changed");` : l)).join("\n");
  return { path, base, head };
};
const small = [fileOf("src/a.ts", 60, [5]), fileOf("src/b.ts", 60, [7]), fileOf("src/c.ts", 60, [9])];
const packed = reviewBatches(small, 9_000);
assert.ok(packed.batches.length >= 2, `three ~4k-char files need more than one 9k pass (${packed.batches.length})`);
assert.deepEqual(packed.batches.flat().map((f) => f.path), ["src/a.ts", "src/b.ts", "src/c.ts"]);
assert.ok(reviewPrompt("x", [], [], packed.batches[0], 9_000)[1].content.length <= 9_000 + 200);
ok("files are packed into whole passes that each fit the budget; every file is reviewed");
const large = fileOf("src/big.ts", 2_000, [100, 1500]);
const lb = fileBlock(large, 14_000);
assert.equal(lb.compact, true);
assert.ok(lb.text.includes("throw new Error") && lb.text.length <= 14_000);
assert.deepEqual(reviewBatches([large]).compact, ["src/big.ts"]);
ok("a file too big to show whole is shown around every change, and the review says so");
const huge = fileOf("src/huge.ts", 6_000, Array.from({ length: 400 }, (_, i) => i * 14));
assert.deepEqual(reviewBatches([huge]).tooBig, ["src/huge.ts"]);
ok("a file with too much change even around each change can't be reviewed (the review is unavailable)");

assert.deepEqual(specialistsFor([{ path: "src/index.ts", added: ["if (qty > 99) return 400;"] }], false, () => false), ["general"]);
assert.deepEqual(specialistsFor([{ path: "src/index.ts", added: ["this.sql.exec(`INSERT INTO bookings VALUES (?)`, x);"] }], true, () => false), ["general", "data"]);
assert.deepEqual(specialistsFor([{ path: "src/auth/session.ts", added: ["return ok;"] }], false, () => false), ["general", "security"]);
assert.deepEqual(specialistsFor([{ path: "src/index.ts", added: ['const token = request.headers.get("authorization");'] }], false, () => false), ["general", "security"]);
assert.deepEqual(specialistsFor([{ path: "src/billing.ts", added: ["x"] }], false, (p) => p.startsWith("src/billing")), ["general", "security"]);
ok("specialists: data for stored-data changes, security for auth, secrets or charter review paths");
