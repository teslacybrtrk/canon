import { DurableObject } from "cloudflare:workers";

// Farmstand: the demo app agents change. Canon's only demand on it is the
// `x-canon-run` header: every check run gets its own market, seeded identically,
// so checks are deterministic and never see each other's carts.

interface Env {
  MARKET: DurableObjectNamespace<Market>;
}

interface Stall {
  id: number;
  name: string;
}

interface Product {
  id: string;
  stallId: number;
  name: string;
  priceCents: number;
  stock: number;
}

const STALLS: Stall[] = [
  { id: 1, name: "Hollow Creek Eggs" },
  { id: 2, name: "Marigold Honey" },
  { id: 3, name: "Two Oaks Greens" },
];

const PRODUCTS: Product[] = [
  { id: "eggs", stallId: 1, name: "Dozen eggs", priceCents: 400, stock: 50 },
  { id: "duck-eggs", stallId: 1, name: "Duck eggs (6)", priceCents: 650, stock: 20 },
  { id: "honey", stallId: 2, name: "Wildflower honey", priceCents: 1200, stock: 0 },
  { id: "comb", stallId: 2, name: "Honeycomb", priceCents: 1500, stock: 5 },
  { id: "kale", stallId: 3, name: "Kale bunch", priceCents: 300, stock: 40 },
  { id: "greens", stallId: 3, name: "Salad greens", priceCents: 450, stock: 30 },
];

export class Market extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stalls (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, stall_id INTEGER NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cart (product_id TEXT PRIMARY KEY, qty INTEGER NOT NULL);
    `);
    if (this.sql.exec(`SELECT COUNT(*) AS n FROM stalls`).one().n === 0) {
      for (const s of STALLS) this.sql.exec(`INSERT INTO stalls VALUES (?, ?)`, s.id, s.name);
      for (const p of PRODUCTS) this.sql.exec(`INSERT INTO products VALUES (?, ?, ?, ?, ?)`, p.id, p.stallId, p.name, p.priceCents, p.stock);
    }
  }

  stalls(): Stall[] {
    return this.sql.exec<{ id: number; name: string }>(`SELECT id, name FROM stalls ORDER BY id`).toArray();
  }

  products(): Product[] {
    return this.sql
      .exec<{ id: string; stall_id: number; name: string; price_cents: number; stock: number }>(`SELECT * FROM products ORDER BY stall_id, id`)
      .toArray()
      .map((r) => ({ id: r.id, stallId: r.stall_id, name: r.name, priceCents: r.price_cents, stock: r.stock }));
  }

  addToCart(productId: string, qty: number): { ok: true } | { ok: false; status: number; error: string } {
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, status: 400, error: "qty must be a positive integer" };
    const product = this.products().find((p) => p.id === productId);
    if (!product) return { ok: false, status: 400, error: `unknown product ${productId}` };
    this.sql.exec(
      `INSERT INTO cart (product_id, qty) VALUES (?, ?) ON CONFLICT(product_id) DO UPDATE SET qty = qty + excluded.qty`,
      productId,
      qty,
    );
    return { ok: true };
  }

  cart() {
    const products = new Map(this.products().map((p) => [p.id, p]));
    const items = this.sql
      .exec<{ product_id: string; qty: number }>(`SELECT product_id, qty FROM cart ORDER BY product_id`)
      .toArray()
      .map(({ product_id, qty }) => {
        const p = products.get(product_id)!;
        return { productId: p.id, name: p.name, qty, unitCents: p.priceCents, lineCents: p.priceCents * qty };
      });
    return { items, totalCents: items.reduce((sum, i) => sum + i.lineCents, 0) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const run = request.headers.get("x-canon-run") ?? "public";
    const market = env.MARKET.get(env.MARKET.idFromName(run));
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /api/stalls") return Response.json(await market.stalls());
    if (route === "GET /api/products") return Response.json(await market.products());
    if (route === "GET /api/cart") return Response.json(await market.cart());
    if (route === "POST /api/cart") {
      const body = await request.json<{ productId?: string; qty?: number }>().catch(() => ({}) as { productId?: string; qty?: number });
      const result = await market.addToCart(String(body.productId ?? ""), Number(body.qty ?? 1));
      return result.ok ? Response.json(await market.cart()) : Response.json({ error: result.error }, { status: result.status });
    }
    if (route === "GET /") return page(await market.stalls(), await market.products(), await market.cart());
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function page(stalls: Stall[], products: Product[], cart: Awaited<ReturnType<Market["cart"]>>) {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const sections = stalls
    .map((s) => {
      const rows = products
        .filter((p) => p.stallId === s.id)
        .map(
          (p) => `<li><span>${esc(p.name)}</span><span>${money(p.priceCents)}</span>
            <button data-id="${p.id}"${p.stock === 0 ? ' class="out"' : ""}>${p.stock === 0 ? "Sold out" : "Add"}</button></li>`,
        )
        .join("");
      return `<section><h2>${esc(s.name)}</h2><ul>${rows}</ul></section>`;
    })
    .join("");
  const lines = cart.items.map((i) => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${money(i.lineCents)}</span></li>`).join("");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Farmstand</title>
<style>
  :root { --bg:#f7f3ea; --ink:#2b2a26; --muted:#6f6a5f; --card:#fffdf7; --line:#e6dfcf; --accent:#4f7a3a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1d1c19; --ink:#efe9dc; --muted:#a59f92; --card:#26241f; --line:#3a372f; --accent:#8fbf6e; } }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 ui-sans-serif,system-ui,sans-serif }
  main { max-width:960px; margin:0 auto; padding:24px 16px; display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)) }
  header { max-width:960px; margin:0 auto; padding:24px 16px 0 } h1 { margin:0; font-size:28px } header p { margin:4px 0 0; color:var(--muted) }
  section, aside { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px }
  h2 { margin:0 0 8px; font-size:18px } ul { list-style:none; margin:0; padding:0 }
  li { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:6px 0; border-top:1px solid var(--line) }
  li span:first-child { flex:1 } button { border:0; border-radius:8px; padding:4px 10px; background:var(--accent); color:#fff; cursor:pointer }
  button.out { background:var(--line); color:var(--muted) } .total { font-weight:600 }
</style></head><body>
<header><h1>Farmstand</h1><p>Saturday market, three stalls.</p></header>
<main>${sections}<aside><h2>Your basket</h2><ul>${lines || "<li><span>Empty</span></li>"}</ul>
<p class="total">Total ${money(cart.totalCents)}</p></aside></main>
<script>
  document.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", async () => {
    const res = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: b.dataset.id, qty: 1 }) });
    if (!res.ok) { b.textContent = (await res.json()).error; return; }
    location.reload();
  }));
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
