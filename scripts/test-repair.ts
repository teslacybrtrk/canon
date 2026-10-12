// Bounded repair: a resolution is accepted only if no markers remain and everything outside the conflicts survives.
import assert from "node:assert/strict";
import { fileFromAnswer, parseConflicts, validResolution } from "../referee/src/repair.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const conflicted = `a
b
<<<<<<< ours
    if (route === "GET /x") return x();
=======
    if (route === "GET /y") return y();
>>>>>>> theirs
c
`;
const p = parseConflicts(conflicted)!;
assert.equal(p.hunks.length, 1);
assert.deepEqual(p.outside.map((s) => s.trim()), ["a\nb", "c"]);
ok("conflict markers split into outside text and hunks");

assert.ok(validResolution(conflicted, `a\nb\n    if (route === "GET /x") return x();\n    if (route === "GET /y") return y();\nc\n`));
ok("a resolution keeping both sides and all outside text is accepted");
assert.ok(!validResolution(conflicted, `a\nb\n<<<<<<< ours\nc\n`));
ok("leftover markers are refused");
assert.ok(!validResolution(conflicted, `a\n    if (route === "GET /x") return x();\nc\n`));
ok("dropping outside text is refused");
assert.equal(fileFromAnswer("```ts\nconst x = 1;\n```"), "const x = 1;\n");
ok("a fenced answer is unwrapped");
