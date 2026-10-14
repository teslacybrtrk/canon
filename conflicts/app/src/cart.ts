import { DurableObject } from "cloudflare:workers";
import { findProduct } from "./catalog";
import { type Quote, quote } from "./pricing";

export type Added = { ok: true } | { ok: false; status: number; error: string };

// One shopper's basket, kept in Durable Object storage under "lines" as { productId: qty }.
export class Cart extends DurableObject {
  async add(id: string, qty: number): Promise<Added> {
    const product = findProduct(id);
    if (!product) return { ok: false, status: 400, error: `unknown product ${id}` };
    const lines = (await this.ctx.storage.get<Record<string, number>>("lines")) ?? {};
    const next = (lines[id] ?? 0) + qty;
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, status: 400, error: "qty must be a whole number, 1 or more" };
    lines[id] = next;
    await this.ctx.storage.put("lines", lines);
    return { ok: true };
  }

  async view(): Promise<Quote> {
    const lines = (await this.ctx.storage.get<Record<string, number>>("lines")) ?? {};
    return quote(Object.entries(lines).map(([id, qty]) => ({ id, qty })));
  }
}
