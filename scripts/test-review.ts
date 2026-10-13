// The reviewer's pure parts: which lines a change added, and that only notes quoting real code survive.
import assert from "node:assert/strict";
import { reviewEvidence } from "../referee/src/evidence.ts";
import { addedLines, changedLines, DIFF_MAX_CELLS, fileBlock, ground, judgeAnswer, parseAnswer, rankNotes, reviewBatches, reviewPrompt, specialistsFor } from "../referee/src/review.ts";

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
assert.deepEqual(ground("not json", files), { notes: [], dropped: 0, droppedRisk: false, unresolved: [] });
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
assert.deepEqual(judgeAnswer('{"notes": []}', "stop", files), { ok: true, notes: [], dropped: 0, unresolved: [] });
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
assert.ok(invented.ok && invented.unresolved.length === 1 && invented.unresolved[0].kind === "risk");
const reviewOf = (j: typeof invented, notes = j.ok ? j.notes : []) => ({ status: "done" as const, model: "m/kimi", notes, dropped: 0, unresolved: j.ok ? j.unresolved : [], at: 0, coverage: { files: 1, reviewed: 1, compact: [], passes: 1, specialists: ["general" as const] } });
assert.equal(reviewEvidence(true, true, reviewOf(invented), 0).state, "unavailable");
ok("a risk the model can't quote from the code is unresolved: required review evidence is unavailable, not clean");
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

// A deletion-only change: a guard taken out of a big file. It has no added lines; the review still shows what was
// removed, and the code around where it was.
const bigBase = Array.from({ length: 1500 }, (_, i) => (i === 700 ? '  if (!isAdmin(user)) return new Response("forbidden", { status: 403 });' : `  const v${i} = ${i}; // ${"x".repeat(30)}`)).join("\n");
const bigHead = bigBase.split("\n").filter((_, i) => i !== 700).join("\n");
const del = changedLines(bigBase, bigHead);
assert.equal(del.added.length, 0);
assert.equal(del.removed.length, 1);
const delBlock = fileBlock({ path: "src/admin.ts", base: bigBase, head: bigHead }, 14_000);
assert.equal(delBlock.compact, true);
assert.match(delBlock.text, /REMOVED LINES[\s\S]*isAdmin\(user\)/);
assert.match(delBlock.text, /const v699 = 699/);
ok("a deleted authorization guard in a big file is shown (the removed line, and the code around where it was)");
assert.deepEqual(specialistsFor([{ path: "src/admin.ts", added: del.removed.map((r) => r.text) }], false, () => false), ["general", "security"]);
ok("and a removed auth check gets the security specialist");

// Findings that govern acceptance are never dropped for room: three untested notes and one intent finding keep the intent.
const many2 = ground({ notes: [1, 2, 3].map(() => ({ file: "src/index.ts", line: 4, quote: "return x;", kind: "untested", note: "n" })).concat([{ file: "src/index.ts", line: 2, quote: "if (!x) return 400;", kind: "intent", note: "does more than asked" }]) }, files);
assert.ok(many2.notes.some((n) => n.kind === "intent"));
ok("an intent finding survives three untested notes (intentRisk can depend on it)");

// The reviewer's case: three general untested notes, three data untested notes, one security intent finding.
const note = (by: "general" | "data" | "security", kind: "untested" | "intent", i: number) => ({ file: "src/index.ts", line: i, quote: "x", kind, note: `${by} ${kind} ${i}`, by });
const across = [...[1, 2, 3].map((i) => note("general", "untested", i)), ...[4, 5, 6].map((i) => note("data", "untested", i)), note("security", "intent", 7)];
const kept = rankNotes(across);
assert.ok(kept.some((n) => n.kind === "intent" && n.by === "security"));
ok("across passes, the security pass's intent finding is kept ahead of six untested notes (the display cap never drops it)");

// Unresolved intent: a well-formed intent finding that quotes code that isn't in the change. Not a confirmed violation,
// but not a clean review: with intentRisk on, the evidence is unavailable (the owner decides), never passed.
{
  const answer = { notes: [
    { file: "src/index.ts", line: 3, quote: "sendMarketingEmail(user)", kind: "intent", note: "it also emails every user, which the fact doesn't ask for" },
    { file: "src/index.ts", line: 2, quote: "if (!x) return 400;", kind: "untested", note: "no fact checks the 400" },
  ] };
  const j = judgeAnswer(answer, "stop", files);
  assert.ok(j.ok);
  assert.equal(j.ok && j.unresolved[0]?.kind, "intent");
  const r = reviewOf(j);
  assert.equal(reviewEvidence(true, true, r, 0, true).state, "unavailable");
  ok("an ungrounded intent finding can't produce passed intent evidence (and a valid untested note doesn't hide it)");
  assert.equal(reviewEvidence(true, true, r, 0, false).state, "passed");
  assert.equal(reviewEvidence(false, true, r, 0, true).state, "not-required");
  ok("where policy doesn't count intent (or doesn't require review), the review stays advisory");
  const clean = judgeAnswer('{"notes": []}', "stop", files);
  assert.equal(reviewEvidence(true, true, reviewOf(clean), 0, true).state, "passed");
  ok("a genuinely empty, valid review still passes");
}

// Order-sensitive diffs in large files: validation moved from before a storage write to after it, in a 4,002-line
// file. Same lines, same counts: a multiset diff saw nothing; the review must show the move.
{
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => `  const v${from + i} = ${from + i};`);
  const before = [...filler(0, 2000), "  if (!valid(input)) return new Response(\"bad\", { status: 400 });", "  await this.ctx.storage.put(key, input);", ...filler(2000, 2000)];
  const after = [...filler(0, 2000), "  await this.ctx.storage.put(key, input);", "  if (!valid(input)) return new Response(\"bad\", { status: 400 });", ...filler(2000, 2000)];
  assert.equal(before.length, 4002);
  const moved = changedLines(before.join("\n"), after.join("\n"));
  assert.ok(moved.complete);
  assert.equal(moved.added.length + moved.removed.length, 2, JSON.stringify(moved));
  const block = fileBlock({ path: "src/store.ts", base: before.join("\n"), head: after.join("\n") }, 14_000);
  assert.ok(block.represented && block.compact);
  assert.match(block.text, /ADDED OR CHANGED LINES:\n\d+: .*(valid|storage)/);
  assert.match(block.text, /REMOVED LINES[\s\S]*(valid|storage)/);
  assert.match(block.text, /storage\.put[\s\S]*valid\(input\)/, "the new file around the change shows the write before the validation");
  ok("a 4,002-line file with validation moved after the write: the review shows the move (a removal and an addition)");

  // Repeated identical lines: the same "}" and "return;" lines everywhere, and one guard moved among them.
  const rep = (guardAt: number) => Array.from({ length: 3000 }, (_, i) => (i === guardAt ? "  if (!user) return deny();" : i % 2 ? "  }" : "  return;")).join("\n");
  const r2 = changedLines(rep(1200), rep(1210));
  assert.ok(r2.complete && r2.added.some((a) => a.text.includes("deny")) && r2.removed.some((x) => x.text.includes("deny")));
  ok("repeated identical lines don't hide a guard moved among them");

  // Excessive change: the changed region is too large to diff, so the file isn't represented; coverage says so.
  const side = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 10;
  const x = Array.from({ length: side }, (_, i) => `a${i}`).join("\n"), y = Array.from({ length: side }, (_, i) => `b${i}`).join("\n");
  assert.equal(changedLines(x, y).complete, false);
  const over = reviewBatches([{ path: "src/rewrite.ts", base: x, head: y }, ...small.slice(0, 1)]);
  assert.deepEqual(over.tooBig, ["src/rewrite.ts"]);
  assert.deepEqual(over.batches.flat().map((f) => f.path), ["src/a.ts"]);
  const partial = { status: "done" as const, model: "m/kimi", notes: [], dropped: 0, at: 0, coverage: { files: 2, reviewed: 1, compact: [], omitted: over.tooBig, passes: 1, specialists: ["general" as const] } };
  const pe = reviewEvidence(true, true, partial, 0);
  assert.equal(pe.state, "unavailable");
  assert.match(pe.detail, /1 of 2 .*src\/rewrite\.ts/);
  ok("too much change to represent: that file is left out and named, the rest still reviewed, and the evidence is unavailable");
}
