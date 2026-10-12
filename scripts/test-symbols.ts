// Which functions a change touches: the overlap that matters when an app lives in one file.
import assert from "node:assert/strict";
import { changedSymbols } from "../referee/src/symbols.ts";

const ok = (name: string) => console.log(`ok   ${name}`);
const base = `export class Market extends DurableObject<Env> {
  stalls(): Stall[] {
    return this.sql.exec("SELECT id, name FROM stalls").toArray();
  }

  addToCart(productId: string, qty: number): Result {
    if (qty < 1) return { ok: false };
    return { ok: true };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return new Response("hi");
  },
};

function page(stalls: Stall[]) {
  return "<html>";
}
`;

const guard = base.replace("    if (qty < 1) return { ok: false };\n", "    if (qty < 1) return { ok: false };\n    if (qty > 99) return { ok: false };\n");
assert.deepEqual(changedSymbols(base, guard), ["Market.addToCart"]);
ok("a guard added inside a method names that method");

const route = base.replace('    return new Response("hi");', '    if (url.pathname === "/x") return new Response("x");\n    return new Response("hi");');
assert.deepEqual(changedSymbols(base, route), ["fetch"]);
ok("a route added inside fetch names fetch");

const both = guard.replace('  return "<html>";', '  return "<html lang=en>";');
assert.deepEqual(changedSymbols(base, both), ["Market.addToCart", "page"]);
ok("changes in two functions name both, and nothing else");

const added = base + "\nfunction reserve(stallId: number) {\n  return stallId;\n}\n";
assert.deepEqual(changedSymbols(base, added), ["reserve"]);
ok("a new function is a changed symbol");

assert.deepEqual(changedSymbols(base, base), []);
ok("no change, no symbols");
