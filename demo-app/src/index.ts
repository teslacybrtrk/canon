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

// How each stall looks on the market page: purely presentational, keyed by stall id.
const STALL_LOOK: Record<number, { tagline: string; tint: string; icon: string }> = {
  1: {
    tagline: "Pasture-raised hens and ducks, collected each morning.",
    tint: "#f3d9a4",
    icon: `<ellipse cx="24" cy="27" rx="11" ry="14" fill="#fffaf0" stroke="#7a5a2b" stroke-width="2"/><ellipse cx="20" cy="22" rx="3" ry="4" fill="#fff" opacity=".7"/>`,
  },
  2: {
    tagline: "Raw wildflower honey and comb from forty hives up the valley.",
    tint: "#f6c453",
    icon: `<path d="M24 8l12 7v14l-12 7-12-7V15z" fill="#f2a516" stroke="#7a4b06" stroke-width="2"/><path d="M24 16l6 3.5v7L24 30l-6-3.5v-7z" fill="#ffd15c"/>`,
  },
  3: {
    tagline: "Kale, chard and tender salad leaves, cut the day before market.",
    tint: "#bcd9a2",
    icon: `<path d="M24 40C12 32 10 18 24 8c14 10 12 24 0 32z" fill="#5f9441" stroke="#2f5420" stroke-width="2"/><path d="M24 40V14M24 22l-6-4M24 28l6-4M24 33l-5-3" stroke="#d6ecc4" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  },
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

function productRow(p: Product) {
  const out = p.stock === 0;
  const left = out ? "Gone for today" : p.stock <= 5 ? `Only ${p.stock} left` : "In stock";
  return `<li class="product${out ? " gone" : ""}">
      <div class="line"><b>${esc(p.name)}</b><span class="price">${money(p.priceCents)}</span></div>
      <div class="line"><small class="${p.stock <= 5 ? "low" : ""}">${left}</small>
        <button type="button" data-id="${esc(p.id)}"${out ? ' class="out"' : ""}>${out ? "Sold out" : "Add"}</button></div>
    </li>`;
}

function stallCard(s: Stall, products: Product[]) {
  const look = STALL_LOOK[s.id] ?? { tagline: "", tint: "#e8e0cc", icon: "" };
  const rows = products.filter((p) => p.stallId === s.id).map(productRow).join("");
  return `<section class="stall" style="--tint:${look.tint}">
      <header><svg viewBox="0 0 48 48" aria-hidden="true">${look.icon}</svg><div><span class="no">Stall ${s.id}</span><h2>${esc(s.name)}</h2></div></header>
      <p class="tag">${esc(look.tagline)}</p>
      <ul>${rows}</ul>
    </section>`;
}

function basket(cart: Awaited<ReturnType<Market["cart"]>>) {
  const lines = cart.items
    .map((i) => `<li><span class="qty">${i.qty}×</span><span>${esc(i.name)}</span><span>${money(i.lineCents)}</span></li>`)
    .join("");
  const count = cart.items.reduce((n, i) => n + i.qty, 0);
  return `<h2>Your basket <span class="count">${count}</span></h2>
    <ul>${lines || `<li class="none">Nothing yet. Add something from a stall.</li>`}</ul>
    <p class="total"><span>Total</span><b>${money(cart.totalCents)}</b></p>
    <p class="pay">Pay at pickup, Saturday 8 am to 1 pm at the old feed barn.</p>`;
}

const STYLE = `
  :root { --paper:#fbf6ea; --card:#fffdf6; --ink:#24301d; --muted:#6b6f5c; --line:#e7dec8; --green:#3f6b2e; --green-2:#2f5420; --tomato:#d2512d; --shadow:0 1px 0 rgb(36 48 29 / .04), 0 12px 30px -18px rgb(36 48 29 / .35); }
  @media (prefers-color-scheme: dark) { :root { --paper:#171a14; --card:#20251b; --ink:#eef0e2; --muted:#a3a892; --line:#343a2c; --green:#86b866; --green-2:#a5d283; --tomato:#ef7a55; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.55 "Work Sans", ui-sans-serif, system-ui, sans-serif }
  .awning { height:34px; background:repeating-linear-gradient(90deg, var(--tomato) 0 36px, #f3e3bf 36px 72px);
    -webkit-mask:linear-gradient(#000 0 0) top / 100% 22px no-repeat, radial-gradient(circle at 18px 0, #000 17.5px, transparent 18px) 0 22px / 36px 12px repeat-x;
    mask:linear-gradient(#000 0 0) top / 100% 22px no-repeat, radial-gradient(circle at 18px 0, #000 17.5px, transparent 18px) 0 22px / 36px 12px repeat-x; filter:drop-shadow(0 3px 2px rgb(0 0 0 / .15)) }
  .hero { max-width:1200px; margin:0 auto; padding:30px 20px 8px; display:flex; flex-wrap:wrap; gap:16px 32px; align-items:end; justify-content:space-between }
  .hero h1 { margin:0; font:600 clamp(40px, 6vw, 64px)/1 "Fraunces", Georgia, serif; letter-spacing:-.02em }
  .hero h1 em { color:var(--green); font-style:italic }
  .hero p { margin:10px 0 0; color:var(--muted); max-width:34em; font-size:17px }
  .when { display:flex; gap:10px; flex-wrap:wrap }
  .when span { padding:6px 12px; border:1px solid var(--line); border-radius:999px; background:var(--card); font-size:14px; color:var(--muted) }
  .when b { color:var(--ink); font-weight:600 }
  main { max-width:1200px; margin:0 auto; padding:24px 20px 56px; display:grid; gap:20px; grid-template-columns:minmax(0, 1fr) 300px; align-items:start }
  .stalls { display:grid; gap:20px; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)) }
  .stall, aside { background:var(--card); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); overflow:hidden }
  .stall header { display:flex; gap:14px; align-items:center; padding:18px 18px 14px; background:linear-gradient(135deg, var(--tint), color-mix(in srgb, var(--tint) 40%, var(--card))) }
  .stall header svg { width:48px; height:48px; flex:none; filter:drop-shadow(0 4px 6px rgb(0 0 0 / .12)) }
  .no { font:600 11px/1 ui-monospace, monospace; letter-spacing:.12em; text-transform:uppercase; color:#4b4a3a }
  .stall h2 { margin:4px 0 0; font:600 22px/1.1 "Fraunces", Georgia, serif; color:#24301d }
  .tag { margin:0; padding:12px 18px 4px; color:var(--muted); font-size:14px }
  ul { list-style:none; margin:0; padding:0 }
  .product { display:grid; gap:4px; padding:12px 18px; border-top:1px dashed var(--line) }
  .line { display:flex; align-items:center; justify-content:space-between; gap:12px }
  .stall ul { padding-bottom:6px }
  .product b { font-weight:600 }
  .product small { color:var(--muted); font-size:12.5px }
  .product small.low { color:var(--tomato) }
  .product.gone b { color:var(--muted) }
  .price { font:600 17px "Fraunces", Georgia, serif; font-variant-numeric:tabular-nums }
  button { font:600 14px "Work Sans", system-ui, sans-serif; border:0; border-radius:999px; padding:6px 16px; background:var(--green); color:#fff; cursor:pointer; transition:transform .12s, background .2s }
  button:hover { background:var(--green-2); transform:translateY(-1px) }
  button:disabled { opacity:.6; cursor:default; transform:none }
  button.out { background:var(--line); color:var(--muted) }
  aside { position:sticky; top:16px; padding:20px }
  aside h2 { margin:0 0 10px; font:600 24px/1 "Fraunces", Georgia, serif; display:flex; align-items:center; gap:10px }
  .count { min-width:26px; height:26px; padding:0 8px; border-radius:13px; background:var(--tomato); color:#fff; font:600 14px/26px "Work Sans", sans-serif; text-align:center }
  aside li { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:10px; padding:9px 0; border-top:1px dashed var(--line); font-size:15px }
  aside li.none { display:block; color:var(--muted) }
  .qty { color:var(--green); font-weight:600 }
  .total { display:flex; justify-content:space-between; align-items:baseline; margin:12px 0 0; padding-top:12px; border-top:2px solid var(--ink) }
  .total b { font:600 26px "Fraunces", Georgia, serif }
  .pay { margin:10px 0 0; color:var(--muted); font-size:13px }
  .toast { position:fixed; left:50%; bottom:24px; transform:translate(-50%, 20px); opacity:0; padding:10px 16px; border-radius:12px; background:var(--ink); color:var(--paper); font-size:14px; transition:.25s; pointer-events:none }
  .toast.on { opacity:1; transform:translate(-50%, 0) }
  footer { max-width:1200px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:13px }
  @media (max-width:860px) { main { grid-template-columns:minmax(0, 1fr) } aside { position:static } }
`;

// Adds an item without a page reload, then redraws the basket from the JSON the API returns.
const SCRIPT = `
  const toast = document.querySelector(".toast");
  const say = (text) => { toast.textContent = text; toast.classList.add("on"); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove("on"), 2200); };
  document.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const res = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: b.dataset.id, qty: 1 }) });
    b.disabled = false;
    if (!res.ok) { say((await res.json()).error); return; }
    const page = await (await fetch("/")).text();
    document.querySelector("aside").innerHTML = new DOMParser().parseFromString(page, "text/html").querySelector("aside").innerHTML;
    say("Added to your basket");
  }));
`;

function page(stalls: Stall[], products: Product[], cart: Awaited<ReturnType<Market["cart"]>>) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Farmstand · Saturday market</title>
<meta name="description" content="Eggs, honey and greens from three local stalls. Order ahead, pick up Saturday.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600&family=Work+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>
<div class="awning" aria-hidden="true"></div>
<div class="hero"><div><h1>Farmstand <em>Saturday market</em></h1><p>Eggs, honey and greens from three family stalls. Fill your basket by Friday night and pick it up fresh.</p></div>
<div class="when"><span><b>Saturday</b> 8 am to 1 pm</span><span><b>${stalls.length}</b> stalls</span><span><b>${products.length}</b> goods</span></div></div>
<main><div class="stalls">${stalls.map((s) => stallCard(s, products)).join("")}</div><aside>${basket(cart)}</aside></main>
<footer>Farmstand is a small co-op of growers. Everything is picked or collected within a day of market.</footer>
<div class="toast" role="status"></div>
<script>${SCRIPT}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
