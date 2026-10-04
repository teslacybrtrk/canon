// Board page sanity checks:  node scripts/test-page.mjs
// Element ids the script relies on must exist exactly once (a duplicate id silently breaks getElementById).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../referee/public/index.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
assert.deepEqual(dup, [], `duplicate ids: ${dup.join(", ")}`);
const used = [...new Set([...html.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]))];
const missing = used.filter((id) => !ids.includes(id));
assert.deepEqual(missing, [], `ids used by the script but missing from the page: ${missing.join(", ")}`);
console.log(`ok  ${ids.length} ids unique; all ${used.length} ids the script uses exist`);
