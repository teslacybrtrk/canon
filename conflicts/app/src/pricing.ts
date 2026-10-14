import { findProduct, type Product } from "./catalog";
import { vatCents } from "./tax";

export interface Line {
  id: string;
  qty: number;
}

// What one line of goods costs, before VAT.
export function lineCents(product: Product, qty: number): number {
  return product.price * qty;
}

// A quote for some lines: what each line costs, the subtotal, VAT and the total, all in cents.
export function quote(lines: Line[]) {
  const priced = lines.map((l) => {
    const product = findProduct(l.id)!;
    return { id: l.id, name: product.name, qty: l.qty, cents: lineCents(product, l.qty) };
  });
  const subtotal = priced.reduce((sum, l) => sum + l.cents, 0);
  const vat = vatCents(subtotal);
  return { lines: priced, subtotal, vat, total: subtotal + vat };
}

export type Quote = ReturnType<typeof quote>;
