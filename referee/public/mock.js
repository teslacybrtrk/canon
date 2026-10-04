// Sample board state for design work: open https://canon.rodeo/?mock
// Covers every claim status and both kinds of "why" (seed fact, accepted fact).
// Every preview link points at the production app, which always exists (rehearsal Previews get deleted on reset).
(() => {
  const GENESIS = "https://farmstand.philipemanuele.workers.dev"; // sample data: the always-on production app
  const DISCOUNT = GENESIS;
  const SOLD_OUT = GENESIS;
  const now = Date.now();
  const check = { kind: "probe", steps: [] };
  const fact = (id, sentence, status, extra = {}) => ({ id, sentence, status, check, scope: null, replaces: null, origin: "seed", proposedBy: null, madeTrueBy: null, retiredBy: null, retiredAt: null, createdAt: now, acceptedAt: status === "canon" ? now : null, ...extra });
  const cmd = (run) => ({ kind: "command", run });
  const KEPT = ["market-lists-stalls", "products-have-prices", "cart-starts-empty", "price-is-listed", "unknown-product-refused", "page-is-fast", "code-typechecks", "code-lints", "sold-out-refused"];
  const verdict = (worldId, previewUrl, outcome, claimed, lost = [], extra = {}) => ({
    worldId, sha: "3cf7cec5a1b2c3d4e5f60718293a4b5c6d7e8f90", previewUrl, canonSeq: 2, outcome,
    kept: KEPT.filter((k) => !lost.some((l) => l.factId === k)), lost, claimed, offers: [], retires: [], skipped: ["tooling-locked"], stale: [],
    ledger: { status: outcome === "behind" ? "behind" : "ok", detail: outcome === "behind" ? "canon gained sold-out-refused after this world forked; declare a fresh world" : "ok" },
    judgedAt: now, ...extra,
  });
  const claim = (id, agent, factId, sentence, status, why, worldId, v) => ({ id, agent, factId, sentence, status, why, worldId, createdAt: now, verdict: v });

  window.CANON_MOCK = {
    state: {
      project: "farmstand",
      canon: { worldId: "farmstand-yplv6l", sha: "14c534b25cd601f7187aed13e6ba50fd923d4634", seq: 2, previewUrl: SOLD_OUT },
      policy: { autoAccept: "off" },
      facts: [
        fact("market-lists-stalls", "The market page lists every stall", "canon"),
        fact("products-have-prices", "All six products are for sale with a price", "canon"),
        fact("cart-starts-empty", "A new shopper's basket is empty", "canon"),
        fact("price-is-listed", "The basket charges the listed price for every unit", "canon"),
        fact("unknown-product-refused", "A product that does not exist cannot be added", "canon"),
        fact("page-is-fast", "The market page answers in under 400 ms (p95 of 20 requests)", "canon"),
        fact("code-typechecks", "The code type-checks with no errors", "canon", { check: cmd("npx tsc --noEmit -p tsconfig.json"), scope: ["src/**", "tsconfig.json"] }),
        fact("code-lints", "The code passes the linter", "canon", { check: cmd("npx biome lint src"), scope: ["src/**", "biome.json"] }),
        fact("tooling-locked", "Lint and type-check settings only change by revision", "canon", { check: cmd("printf … | sha256sum -c"), scope: ["biome.json", "tsconfig.json"] }),
        fact("sold-out-refused", "A sold-out product cannot be added to the basket", "canon", { madeTrueBy: "farmstand-yplv6l" }),
        fact("bulk-discount", "Buying 10 or more of one item takes 10% off that line", "proposed"),
        fact("no-double-booking", "A stall cannot be double-booked", "proposed"),
        fact("search-by-name", "Shoppers can search products by name", "proposed"),
        fact("stall-hours", "Every stall shows its opening hours", "proposed", { origin: "backlog" }),
        fact("price-with-bulk-discount", "The basket charges the listed price, with 10% off any line of 10 or more", "proposed", { origin: "agent", replaces: "price-is-listed" }),
        fact("free-delivery", "Orders over $50 ship free", "retired", { retiredBy: "farmstand-x1y2z3", retiredAt: now }),
      ],
      claims: [
        claim("c-1", "agent-1", "bulk-discount", "Buying 10 or more of one item takes 10% off that line", "contradicts", "Wholesale buyers asked for a discount", "farmstand-dkw3cr",
          verdict("farmstand-dkw3cr", DISCOUNT, "contradicts", { factId: "bulk-discount", held: true, detail: "ok" }, [{ factId: "price-is-listed", detail: "step 2: totalCents is 4320, expected 4800" }])),
        claim("c-9", "agent-1", "price-with-bulk-discount", "The basket charges the listed price, with 10% off any line of 10 or more", "ready", "The business is changing its pricing rule for wholesale buyers", "farmstand-r3v1s0",
          { ...verdict("farmstand-r3v1s0", DISCOUNT, "ready", { factId: "price-with-bulk-discount", held: true, detail: "ok" }), kept: KEPT.filter((k) => k !== "price-is-listed"), retires: ["price-is-listed"] }),
        claim("c-2", "agent-2", "no-double-booking", "A stall cannot be double-booked", "ready", "Vendors keep fighting over stall 1", "farmstand-p2q8zz",
          verdict("farmstand-p2q8zz", SOLD_OUT, "ready", { factId: "no-double-booking", held: true, detail: "ok" })),
        claim("c-3", "agent-3", "no-double-booking", "A stall cannot be double-booked", "unproven", "Joining the reservation race", "farmstand-m4n1aa",
          verdict("farmstand-m4n1aa", SOLD_OUT, "unproven", { factId: "no-double-booking", held: false, detail: "step 2: POST /api/reservations returned 201, expected 409" })),
        claim("c-4", "agent-5", "search-by-name", "Shoppers can search products by name", "behind", "Shoppers want to find eggs fast", "farmstand-9tw8ex",
          verdict("farmstand-9tw8ex", GENESIS, "behind", { factId: "search-by-name", held: true, detail: "ok" })),
        claim("c-5", "agent-6", "stall-hours", "Every stall shows its opening hours", "checking", "People show up before the stalls open", "farmstand-h7k2qq", null),
        claim("c-6", "human:philip", "stall-hours", "Every stall shows its opening hours", "open", "Trying it by hand", "farmstand-q1w2e3", null),
        claim("c-7", "agent-4", "sold-out-refused", "A sold-out product cannot be added to the basket", "accepted", "Honey keeps getting oversold", "farmstand-yplv6l",
          verdict("farmstand-yplv6l", SOLD_OUT, "ready", { factId: "sold-out-refused", held: true, detail: "ok" })),
        claim("c-8", "agent-7", "sold-out-refused", "A sold-out product cannot be added to the basket", "superseded", "Also fixing oversold honey", "farmstand-z9y8xx",
          verdict("farmstand-z9y8xx", GENESIS, "ready", { factId: "sold-out-refused", held: true, detail: "ok" })),
      ],
    },
    why: {
      "price-is-listed": {
        fact: fact("price-is-listed", "The basket charges the listed price for every unit", "canon"),
        madeTrueBy: null,
        rejected: [{ world_id: "farmstand-dkw3cr", sha: "3cf7cec5", held: 0, detail: "step 2: totalCents is 4320, expected 4800", at: now, preview_url: DISCOUNT, agent: "agent-1", why: "Wholesale buyers asked for a discount", status: "contradicts", kind: "contradiction" }],
        held: [],
      },
      "sold-out-refused": {
        fact: fact("sold-out-refused", "A sold-out product cannot be added to the basket", "canon", { madeTrueBy: "farmstand-yplv6l" }),
        madeTrueBy: {
          world: { id: "farmstand-yplv6l", previewUrl: SOLD_OUT },
          claim: { id: "c-7", agent: "agent-4", why: "Honey keeps getting oversold", factId: "sold-out-refused", status: "accepted" },
        },
        rejected: [{ world_id: "farmstand-genesis", sha: "aac567fd", held: 0, detail: "step 1: POST /api/cart returned 200, expected 409", at: now, preview_url: GENESIS, agent: "agent-7", why: "Also fixing oversold honey", status: "superseded", kind: "attempt" }],
        held: [],
      },
    },
  };
})();
