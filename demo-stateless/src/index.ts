// Pricecheck: a stateless Worker that quotes farmstand prices. It has no storage at all, so every request may be
// served by any version: the app Canon's gradual rollout (canary) is shown on.

interface Item {
  id: string;
  name: string;
  cents: number;
}

const ITEMS: Item[] = [
  { id: "eggs", name: "Dozen eggs", cents: 400 },
  { id: "honey", name: "Wildflower honey", cents: 1200 },
  { id: "kale", name: "Kale bunch", cents: 300 },
];

export function quote(id: string, qty: number): { ok: true; cents: number } | { ok: false; status: number; error: string } {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) return { ok: false, status: 400, error: `unknown item ${id}` };
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, status: 400, error: "qty must be a positive integer" };
  return { ok: true, cents: item.cents * qty };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/items") return Response.json(ITEMS);
    if (url.pathname === "/api/quote") {
      const q = quote(url.searchParams.get("item") ?? "", Number(url.searchParams.get("qty") ?? "1"));
      return q.ok ? Response.json({ cents: q.cents }) : Response.json({ error: q.error }, { status: q.status });
    }
    if (url.pathname === "/") {
      const rows = ITEMS.map((i) => `<li>${i.name}: $${(i.cents / 100).toFixed(2)}</li>`).join("");
      return new Response(`<!doctype html><title>Pricecheck</title><h1>Pricecheck</h1><ul>${rows}</ul>`, { headers: { "content-type": "text/html" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler;
