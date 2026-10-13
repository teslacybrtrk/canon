# Facts worth copying

A fact is a sentence and a check. Most strong facts follow a few shapes. Each one below is a complete `canon.json`
entry you can copy and adapt, with what it catches, what it can't, and how the rollback rehearsal reads back what
it writes (its **fixture contract**, see [PROTOCOL.md](../PROTOCOL.md)).

Two rules carry through all of them:

- **Every request carries `x-canon-run`.** The judge sends a fresh run id with each check, and the app keeps that
  run's state apart (a Durable Object per run, a key prefix). That makes a check repeatable and lets six of them run at
  once. Facts with `"isolate": false` send nothing extra, which suits read-only, stateless facts.
- **A fact that writes should read back what it wrote, with a GET step.** That GET is what the rollback rehearsal runs
  with the previous version against what this version wrote. A fact that writes and never reads makes a rehearsal
  that needs it **unavailable** (the owner decides). If a fact truly leaves nothing behind, say so with
  `"fixture": "none"`; a write the fact expects to be refused (a 4xx) needs nothing.

Mutation findings ("these breaks of your change went unnoticed") and reviewer notes ("no fact checks this guard") point
at facts worth adding. They never change a fact themselves: a fact changes only when a person accepts a revision.

## Concurrency: exactly one wins

```json
{ "id": "no-double-booking", "sentence": "A stall cannot be double-booked",
  "check": { "kind": "probe", "steps": [
    { "method": "POST", "path": "/api/reservations", "body": { "stallId": 2, "date": "2026-11-14", "name": "shopper-{{i}}" },
      "concurrent": 6, "expect": { "status": [201, 409], "statusCounts": { "201": 1, "409": 5 } } },
    { "path": "/api/reservations?stallId=2&date=2026-11-14", "expect": { "status": 200, "bodyIncludes": "shopper-" } } ] } }
```

Catches a check-then-await-then-insert that a sequential probe passes (two requests interleave at the `await`).
Can't prove the absence of a race: six copies at once is a strong hint, not a proof, and a race that needs more
contention or other timing can still pass. The GET is the read-back.

## Retries and idempotency: the same request twice is one effect

```json
{ "id": "checkout-idempotent", "sentence": "Retrying a checkout with the same key charges once",
  "check": { "kind": "probe", "vars": { "key": { "oneOf": ["k-1", "k-2", "k-3"] } }, "steps": [
    { "method": "POST", "path": "/api/checkout", "body": { "idempotencyKey": "{{key}}" }, "expect": { "status": [200, 201] }, "save": { "order": "orderId" } },
    { "method": "POST", "path": "/api/checkout", "body": { "idempotencyKey": "{{key}}" }, "expect": { "status": [200, 201], "json": { "orderId": "{{order}}" } } },
    { "path": "/api/orders", "expect": { "status": 200, "json": { "length": 1 } } } ] } }
```

Catches a retry that creates a second order or overwrites the first. The saved `order` id travels with the fixture,
so the rehearsal's read finds the same order. Can't catch a retry that arrives during the first request (use a
`concurrent` step for that) or one that differs in its body.

## Authorization: who may not

```json
{ "id": "only-owner-edits", "sentence": "A shopper can't change another shopper's basket",
  "check": { "kind": "probe", "steps": [
    { "method": "POST", "path": "/api/cart", "body": { "productId": "eggs", "qty": 2 }, "expect": { "status": 200 }, "save": { "cart": "id" } },
    { "method": "DELETE", "path": "/api/cart/{{cart}}/eggs", "expect": { "status": 403 } },
    { "path": "/api/cart", "expect": { "status": 200, "json": { "items.length": 1 } } } ] } }
```

Catches a removed or loosened permission check (the DELETE succeeds, the basket empties). Write the refused request
the way a real attacker would send it; a fact can only test the paths it names, so pair it with the charter's
`review` globs for auth code (a person or the security specialist reads every change there).

## Data compatibility: old code reads new data

```json
{ "id": "profile-reads-back", "sentence": "A saved profile reads back with its name",
  "check": { "kind": "probe", "vars": { "who": { "oneOf": ["Ada", "Bo"] } }, "steps": [
    { "method": "POST", "path": "/profiles", "body": { "name": "{{who}}" }, "expect": { "status": 201 }, "save": { "id": "id" } },
    { "path": "/profiles/{{id}}", "expect": { "status": 200, "json": { "name": "{{who}}" } } } ] } }
```

This is the shape the rollback rehearsal compares best: the new version writes the profile, the previous version reads
it back by the saved id, beside a profile it wrote itself. A new storage format the old code can't read fails the
rehearsal, and autopilot doesn't release it. It covers the formats this fact writes, not every row production has;
facts for each stored shape that matters cover more.

## Latency budget

```json
{ "id": "page-is-fast", "sentence": "The market page answers in under 400 ms (p95 of 20 requests)",
  "check": { "kind": "probe", "isolate": false, "steps": [{ "path": "/", "repeat": 20, "expect": { "status": 200, "p95Ms": 400 } }] } }
```

Read-only and stateless, so `"isolate": false`. Measured from the judge's location to a preview, so it's a regression
guard, not a production SLO.

## Inputs: generated, not hand-picked

```json
{ "id": "quote-is-price-times-qty", "sentence": "A quote is the item's price times the quantity",
  "check": { "kind": "probe", "isolate": false, "samples": 3,
    "vars": { "qty": { "int": [1, 9] }, "item": { "oneOf": [{ "id": "eggs", "cents": 400 }, { "id": "kale", "cents": 300 }] } },
    "steps": [{ "path": "/api/quote?item={{item.id}}&qty={{qty}}", "expect": { "status": 200, "json": { "cents": "{{qty * item.cents}}" } } }] } }
```

The judge draws the inputs from a seed it picks after each push (recorded in the verdict), so an agent can't fit its
code to the values. Three samples per check; expectations can add and multiply.

## When a fact fails, what kind of failure is it?

Every failed verdict carries a diagnosis (`DIAGNOSIS` in `canon verdict`, and over MCP) that says what to do next:

| Kind | What it means | Who acts |
|---|---|---|
| implementation | the change breaks a canon fact, or doesn't make its own fact true yet | the agent |
| combination | it held on its own base and breaks only together with what became canon since | the agent (or the owner picks one rule) |
| requirement | the fact already held before the change, or several independent attempts fail it the same way | the owner (only a person changes a fact) |
| unsupported-check | the release couldn't establish what it needs (a fact that writes with no read-back) | the owner adds evidence, or accepts the exception |
| infrastructure | the platform failed, not the code | nobody: the judge retries it |
