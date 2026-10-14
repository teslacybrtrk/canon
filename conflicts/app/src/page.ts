import type { Product } from "./catalog";
import { LOW_STOCK, SHOP_NAME } from "./config";
import { money } from "./money";
import type { Quote } from "./pricing";

// The shop page: every product with its price, and the shopper's basket.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function row(p: Product): string {
  const left = p.stock === 0 ? "sold out" : p.stock <= LOW_STOCK ? `only ${p.stock} left` : "in stock";
  return `<li>${esc(p.name)}: ${money(p.price)} <small>${left}</small></li>`;
}

export function shopPage(products: Product[], basket: Quote): Response {
  const lines = basket.lines.map((l) => `<li>${l.qty} × ${esc(l.name)}: ${money(l.cents)}</li>`).join("");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${SHOP_NAME}</title></head><body>
<h1>${SHOP_NAME}</h1>
<ul>${products.map(row).join("")}</ul>
<h2>Your basket</h2>
<ul>${lines || "<li>Nothing yet.</li>"}</ul>
<p>Total, VAT included: ${money(basket.total)}</p>
</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
