# Feature patches for demo-stateless (the benchmark and the canary test): python3 scripts/stateless-patches.py <dir> <feature>
import sys
d, feat = sys.argv[1], sys.argv[2]
p = d + "/src/index.ts"; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (feat, a[:60]); s = s.replace(a, b)
if feat == "bulk-discount":
    rep("  return { ok: true, cents: item.cents * qty };", "  const cents = item.cents * qty;\n  return { ok: true, cents: qty >= 10 ? Math.round(cents * 0.9) : cents };")
elif feat == "quote-has-name":
    rep("export function quote(id: string, qty: number): { ok: true; cents: number }", "export function quote(id: string, qty: number): { ok: true; cents: number; name: string }")
    rep("  return { ok: true, cents: item.cents * qty };", "  return { ok: true, cents: item.cents * qty, name: item.name };")
    rep("      return q.ok ? Response.json({ cents: q.cents })", "      return q.ok ? Response.json({ name: q.name, cents: q.cents })")
elif feat == "quote-has-name-flaky":
    # The same feature, plus an upstream call that fails one request in eight: every check passes on a retry.
    rep("export function quote(id: string, qty: number): { ok: true; cents: number }", "export function quote(id: string, qty: number): { ok: true; cents: number; name: string }")
    rep("  return { ok: true, cents: item.cents * qty };", "  return { ok: true, cents: item.cents * qty, name: item.name };")
    rep("      return q.ok ? Response.json({ cents: q.cents })", "      return q.ok ? Response.json({ name: q.name, cents: q.cents })")
    rep("export default {\n  async fetch(request) {\n    const url = new URL(request.url);", "let hits = 0;\n\nexport default {\n  async fetch(request) {\n    const url = new URL(request.url);\n    // A new upstream lookup that times out now and then.\n    if (url.pathname.startsWith(\"/api/\") && ++hits % 8 === 0) return new Response(\"upstream busy\", { status: 503 });")
elif feat in ("item-page", "item-page-flaky"):
    # GET /api/items/:id returns one item; the flaky variant adds an upstream lookup failing one request in eight.
    rep("    if (url.pathname === \"/api/items\") return Response.json(ITEMS);", "    if (url.pathname === \"/api/items\") return Response.json(ITEMS);\n    const one = url.pathname.match(/^\\/api\\/items\\/([\\w-]+)$/);\n    if (one) {\n      const item = ITEMS.find((i) => i.id === one[1]);\n      return item ? Response.json(item) : Response.json({ error: \"not found\" }, { status: 404 });\n    }")
    if feat == "item-page-flaky":
        rep("export default {\n  async fetch(request) {\n    const url = new URL(request.url);", "let hits = 0;\n\nexport default {\n  async fetch(request) {\n    const url = new URL(request.url);\n    // A new upstream lookup that times out now and then.\n    if (url.pathname.startsWith(\"/api/\") && ++hits % 8 === 0) return new Response(\"upstream busy\", { status: 503 });")
elif feat == "quote-has-name-alt":
    # The same feature written differently (a second agent's duplicate): the name is looked up in the route, not quote().
    rep("      return q.ok ? Response.json({ cents: q.cents })", "      const named = ITEMS.find((i) => i.id === url.searchParams.get(\"item\"));\n      return q.ok ? Response.json({ name: named?.name, cents: q.cents })")
elif feat == "item-link":
    # A quote links to its item's page (GET /api/items/:id), which another change adds: a prerequisite.
    rep("      return q.ok ? Response.json({ cents: q.cents })", "      return q.ok ? Response.json({ cents: q.cents, item: `/api/items/${url.searchParams.get(\"item\")}` })")
open(p, "w").write(s); print("applied", feat)
