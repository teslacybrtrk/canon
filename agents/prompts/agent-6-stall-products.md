Goal: vendors want a link that shows only their own stall's goods. Make this fact true:
"Each stall lists its own products."
The fact file is claims/stall-products.json. Another agent races you for this fact with a different approach;
if it is already claimed, join the race: canon claim --join stall-products --why "<why it matters>".
Add GET /api/stalls/:id/products in the Worker's fetch handler, filtering the product list the Market
already returns. Declare it, implement it, push, read the verdict.
