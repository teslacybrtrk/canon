// Fact scopes and changed-file detection:  node scripts/test-scope.ts
import assert from "node:assert/strict";
import { diffTrees, globToRegExp, inScope } from "../referee/src/scope.ts";

const m = (glob: string, path: string) => globToRegExp(glob).test(path);
assert.ok(m("src/**", "src/index.ts") && m("src/**", "src/db/orders.ts"));
assert.ok(m("migrations/*.sql", "migrations/001_init.sql") && !m("migrations/*.sql", "migrations/old/001.sql"));
assert.ok(m("**/*.sql", "db/x.sql") && m("**/*.sql", "x.sql") && !m("src/*.ts", "src/db/a.ts"));
console.log("ok  globs: **, *, nested paths");

assert.equal(inScope(null, ["README.md"]), true);
assert.equal(inScope(["src/**"], ["README.md"]), false);
assert.equal(inScope(["src/**"], ["README.md", "src/index.ts"]), true);
assert.equal(inScope(["src/**"], null), true);
console.log("ok  inScope: unscoped always, scoped only when a matching file changed, unknown changes judge everything");

// Two Git trees as a fake Artifacts reader.
const trees: Record<string, Array<{ name: string; hash: string; type: string }>> = {
  root1: [{ name: "README.md", hash: "r1", type: "blob" }, { name: "src", hash: "s1", type: "tree" }, { name: "docs", hash: "d1", type: "tree" }],
  root2: [{ name: "README.md", hash: "r1", type: "blob" }, { name: "src", hash: "s2", type: "tree" }, { name: "docs", hash: "d1", type: "tree" }, { name: "biome.json", hash: "b1", type: "blob" }],
  s1: [{ name: "index.ts", hash: "i1", type: "blob" }, { name: "db", hash: "db1", type: "tree" }],
  s2: [{ name: "index.ts", hash: "i2", type: "blob" }, { name: "db", hash: "db1", type: "tree" }],
};
let reads = 0;
const repo = { readTree: async (h: string) => { reads++; return trees[h] ?? null; } };
const changed = await diffTrees(repo, "root1", "root2");
assert.deepEqual(changed.sort(), ["biome.json", "src/index.ts"]);
assert.ok(!trees.d1 && reads === 4, `unchanged subtrees are skipped (reads=${reads})`);
console.log(`ok  diffTrees: ${changed.join(", ")} (unchanged docs/ and src/db/ never read)`);
