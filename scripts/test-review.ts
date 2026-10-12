// The reviewer's pure parts: which lines a change added, and that only notes quoting real code survive.
import assert from "node:assert/strict";
import { addedLines, ground, parseAnswer, reviewPrompt } from "../referee/src/review.ts";

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

assert.deepEqual(ground("not json", files), { notes: [], dropped: 0 });
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
