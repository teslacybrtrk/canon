import { Cart } from "./cart";
import { findProduct, products } from "./catalog";
import { shopPage } from "./page";
import { quote } from "./pricing";

// Corner Larder: a small shop the designed conflict cases change (docs/conflicts.md). Each module is one concern:
// catalog, pricing, tax, money (formatting), config, the basket (a Durable Object) and the shop page.

export { Cart };

interface Env {
  CART: DurableObjectNamespace<Cart>;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // Each check run gets a basket of its own (the x-canon-run header); visitors share the shop's.
    const cart = env.CART.get(env.CART.idFromName(request.headers.get("x-canon-run") ?? "shop"));

    if (route === "GET /") return shopPage(products(), await cart.view());
    if (route === "GET /api/products") return Response.json(products());
    if (route === "GET /api/quote") return quoteFor(url);
    if (route === "GET /api/cart") return Response.json(await cart.view());
    if (route === "POST /api/cart") return addToCart(request, cart);
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// GET /api/quote?item=eggs&qty=2: what that many would cost.
function quoteFor(url: URL): Response {
  const id = url.searchParams.get("item") ?? "";
  const qty = Number(url.searchParams.get("qty") ?? "1");
  if (!findProduct(id)) return Response.json({ error: `unknown item ${id}` }, { status: 400 });
  if (!Number.isInteger(qty) || qty < 1) return Response.json({ error: "qty must be a whole number, 1 or more" }, { status: 400 });
  return Response.json(quote([{ id, qty }]));
}

// POST /api/cart {"id": "eggs", "qty": 2}: adds a line to the basket.
async function addToCart(request: Request, cart: DurableObjectStub<Cart>): Promise<Response> {
  const body = await request.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const id = String(body.id ?? "");
  const qty = body.qty === undefined ? 1 : Number(body.qty);
  const added = await cart.add(id, qty);
  return added.ok ? Response.json(await cart.view()) : Response.json({ error: added.error }, { status: added.status });
}
