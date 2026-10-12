Goal: the market manager wants each stall's goods read straight from the market's database. Make this fact true:
"Each stall lists its own products."
The fact file is claims/stall-products.json. Another agent races you for this fact with a different approach;
if it is already claimed, join the race: canon claim --join stall-products --why "<why it matters>".
Add a Market method that selects one stall's products in SQL (WHERE stall_id = ?) and route
GET /api/stalls/:id/products to it. Declare it, implement it, push, read the verdict.
