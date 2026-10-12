import sys
d, feat = sys.argv[1], sys.argv[2]
p = d + "/src/index.ts"; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (feat, a[:60]); s = s.replace(a, b)
if feat == "sold-out-refused":
    rep("""    if (!product) return { ok: false, status: 400, error: `unknown product ${productId}` };\n""",
        """    if (!product) return { ok: false, status: 400, error: `unknown product ${productId}` };\n    if (product.stock < 1) return { ok: false, status: 409, error: `${productId} is sold out` };\n""")
elif feat == "search-by-name":
    rep("""    if (route === "GET /api/products") return Response.json(await market.products());""",
        """    if (route === "GET /api/products") {\n      const q = (url.searchParams.get("q") ?? "").toLowerCase();\n      const all = await market.products();\n      return Response.json(q ? all.filter((p) => p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)) : all);\n    }""")
elif feat == "product-page":
    rep("""    if (route === "GET /") return page(""",
        """    const one = url.pathname.match(/^\\/api\\/products\\/([\\w-]+)$/);\n    if (request.method === "GET" && one) {\n      const product = (await market.products()).find((p) => p.id === one[1]);\n      return product ? Response.json(product) : Response.json({ error: "not found" }, { status: 404 });\n    }\n    if (route === "GET /") return page(""")
elif feat == "line-limit":
    rep("""    if (!Number.isInteger(qty) || qty < 1) return { ok: false, status: 400, error: "qty must be a positive integer" };\n""",
        """    if (!Number.isInteger(qty) || qty < 1) return { ok: false, status: 400, error: "qty must be a positive integer" };\n    if (qty > 99) return { ok: false, status: 400, error: "a basket line holds at most 99 units" };\n""")
elif feat == "stall-products":
    rep("""    if (route === "GET /api/stalls") return Response.json(await market.stalls());\n""",
        """    if (route === "GET /api/stalls") return Response.json(await market.stalls());\n    const stall = url.pathname.match(/^\\/api\\/stalls\\/(\\d+)\\/products$/);\n    if (request.method === "GET" && stall) return Response.json((await market.products()).filter((p) => p.stallId === Number(stall[1])));\n""")
elif feat == "remove-from-basket":
    rep("""  cart() {\n""", """  removeFromCart(productId: string): boolean {\n    const had = this.sql.exec(`SELECT 1 FROM cart WHERE product_id = ?`, productId).toArray().length > 0;\n    this.sql.exec(`DELETE FROM cart WHERE product_id = ?`, productId);\n    return had;\n  }\n\n  cart() {\n""")
    rep("""    if (route === "GET /api/cart") return Response.json(await market.cart());\n""", """    if (route === "GET /api/cart") return Response.json(await market.cart());\n    const line = url.pathname.match(/^\\/api\\/cart\\/([\\w-]+)$/);\n    if (request.method === "DELETE" && line) return (await market.removeFromCart(line[1])) ? Response.json(await market.cart()) : Response.json({ error: "not in the basket" }, { status: 404 });\n""")
elif feat == "no-double-booking":
    rep("""      CREATE TABLE IF NOT EXISTS cart (product_id TEXT PRIMARY KEY, qty INTEGER NOT NULL);\n""", """      CREATE TABLE IF NOT EXISTS cart (product_id TEXT PRIMARY KEY, qty INTEGER NOT NULL);\n      CREATE TABLE IF NOT EXISTS reservations (stall_id INTEGER NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (stall_id, date));\n""")
    rep("""  cart() {\n""", """  reserve(stallId: number, date: string, name: string): number {\n    if (!this.stalls().some((s) => s.id === stallId) || !date || !name) return 400;\n    if (this.sql.exec(`SELECT 1 FROM reservations WHERE stall_id = ? AND date = ?`, stallId, date).toArray().length) return 409;\n    this.sql.exec(`INSERT INTO reservations VALUES (?, ?, ?)`, stallId, date, name);\n    return 201;\n  }\n\n  cart() {\n""")
    rep("""    if (route === "GET /") return page(""", """    if (route === "POST /api/reservations") {\n      const b = await request.json<{ stallId?: number; date?: string; name?: string }>().catch(() => ({}) as { stallId?: number; date?: string; name?: string });\n      const status = await market.reserve(Number(b.stallId), String(b.date ?? ""), String(b.name ?? ""));\n      return Response.json(status === 201 ? { ok: true } : { error: status === 409 ? "already booked" : "bad booking" }, { status });\n    }\n    if (route === "GET /") return page(""")
elif feat == "stall-hours":
    rep("""    return this.sql.exec<{ id: number; name: string }>(`SELECT id, name FROM stalls ORDER BY id`).toArray();""",
        """    const hours: Record<number, string> = { 1: "8am-1pm", 2: "9am-2pm", 3: "7am-noon" };\n    return this.sql.exec<{ id: number; name: string }>(`SELECT id, name FROM stalls ORDER BY id`).toArray().map((s) => ({ ...s, hours: hours[s.id] ?? "9am-1pm" }));""")
    rep("""      <p class="tag">${esc(look.tagline)}</p>""", """      <p class="tag">${esc(look.tagline)} · Open ${esc((s as Stall & { hours?: string }).hours ?? "")}</p>""")
elif feat == "remove-from-basket2":
    rep("""  cart() {\n""", """  removeFromCart(productId: string): boolean {\n    const had = this.sql.exec(`SELECT 1 FROM cart WHERE product_id = ?`, productId).toArray().length > 0;\n    this.sql.exec(`DELETE FROM cart WHERE product_id = ?`, productId);\n    return had;\n  }\n\n  cart() {\n""")
    rep("""    if (route === "POST /api/cart") {
      const body = await request.json<{ productId?: string; qty?: number }>().catch(() => ({}) as { productId?: string; qty?: number });
      const result = await market.addToCart(String(body.productId ?? ""), Number(body.qty ?? 1));
      return result.ok ? Response.json(await market.cart()) : Response.json({ error: result.error }, { status: result.status });
    }\n""", """    if (route === "POST /api/cart") return addLine(request, market);\n    if (request.method === "DELETE") return removeLine(url, market);\n""")
    rep("""function stallCard(""", """// POST /api/cart adds a line to the basket.\nasync function addLine(request: Request, market: DurableObjectStub<Market>): Promise<Response> {\n  const body = await request.json<{ productId?: string; qty?: number }>().catch(() => ({}) as { productId?: string; qty?: number });\n  const result = await market.addToCart(String(body.productId ?? ""), Number(body.qty ?? 1));\n  return result.ok ? Response.json(await market.cart()) : Response.json({ error: result.error }, { status: result.status });\n}\n\n// DELETE /api/cart/:productId takes a line out of the basket.\nasync function removeLine(url: URL, market: DurableObjectStub<Market>): Promise<Response> {\n  const line = url.pathname.match(/^\\/api\\/cart\\/([\\w-]+)$/);\n  if (!line) return Response.json({ error: "not found" }, { status: 404 });\n  return (await market.removeFromCart(line[1])) ? Response.json(await market.cart()) : Response.json({ error: "not in the basket" }, { status: 404 });\n}\n\nfunction stallCard(""")
elif feat == "no-double-booking2":
    rep("""      CREATE TABLE IF NOT EXISTS cart (product_id TEXT PRIMARY KEY, qty INTEGER NOT NULL);\n""", """      CREATE TABLE IF NOT EXISTS cart (product_id TEXT PRIMARY KEY, qty INTEGER NOT NULL);\n      CREATE TABLE IF NOT EXISTS reservations (stall_id INTEGER NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (stall_id, date));\n""")
    rep("""  products(): Product[] {\n""", """  reserve(stallId: number, date: string, name: string): number {\n    if (!this.stalls().some((s) => s.id === stallId) || !date || !name) return 400;\n    if (this.sql.exec(`SELECT 1 FROM reservations WHERE stall_id = ? AND date = ?`, stallId, date).toArray().length) return 409;\n    this.sql.exec(`INSERT INTO reservations VALUES (?, ?, ?)`, stallId, date, name);\n    return 201;\n  }\n\n  products(): Product[] {\n""")
    rep("""    if (route === "GET /") return page(""", """    if (route === "POST /api/reservations") return reserve(request, market);\n    if (route === "GET /") return page(""")
    s = s + """\n// POST /api/reservations books a stall for a day, once.\nasync function reserve(request: Request, market: DurableObjectStub<Market>): Promise<Response> {\n  const b = await request.json<{ stallId?: number; date?: string; name?: string }>().catch(() => ({}) as { stallId?: number; date?: string; name?: string });\n  const status = await market.reserve(Number(b.stallId), String(b.date ?? ""), String(b.name ?? ""));\n  return Response.json(status === 201 ? { ok: true } : { error: status === 409 ? "already booked" : "bad booking" }, { status });\n}\n"""
elif feat == "stall-hours-schema":
    rep("""      CREATE TABLE IF NOT EXISTS stalls (id INTEGER PRIMARY KEY, name TEXT NOT NULL);""", """      CREATE TABLE IF NOT EXISTS stalls (id INTEGER PRIMARY KEY, name TEXT NOT NULL, hours TEXT NOT NULL DEFAULT '8am-1pm');""")
    rep("""INSERT INTO stalls VALUES (?, ?)""", """INSERT INTO stalls (id, name) VALUES (?, ?)""")
    rep("""    return this.sql.exec<{ id: number; name: string }>(`SELECT id, name FROM stalls ORDER BY id`).toArray();""", """    return this.sql.exec<{ id: number; name: string; hours: string }>(`SELECT id, name, hours FROM stalls ORDER BY id`).toArray();""")
    rep("""      <p class="tag">${esc(look.tagline)}</p>""", """      <p class="tag">${esc(look.tagline)} · Open ${esc((s as Stall & { hours?: string }).hours ?? "")}</p>""")
open(p, "w").write(s); print("applied", feat)
