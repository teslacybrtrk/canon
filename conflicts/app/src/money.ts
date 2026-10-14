// Cents, written for people: 1234 -> "$12.34".
export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
