// The catalog: what the shop sells. Prices are in cents.

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
}

const CATALOG: Product[] = [
  { id: "eggs", name: "Dozen eggs", price: 400, stock: 500 },
  { id: "honey", name: "Wildflower honey", price: 1200, stock: 0 },
  { id: "kale", name: "Kale bunch", price: 320, stock: 40 },
  { id: "comb", name: "Honeycomb", price: 1600, stock: 5 },
  { id: "greens", name: "Salad greens", price: 480, stock: 8 },
];

// The products the shop sells, sold out or not.
export function products(): Product[] {
  return CATALOG;
}

export function findProduct(id: string): Product | undefined {
  return products().find((p) => p.id === id);
}
