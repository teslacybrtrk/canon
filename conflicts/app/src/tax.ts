// VAT, charged on the price of the goods.
export const VAT_RATE = 0.25;

export function vatCents(subtotal: number): number {
  return Math.round(subtotal * VAT_RATE);
}
