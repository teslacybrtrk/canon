# The Canon protocol

Canon is a small protocol on top of Cloudflare Artifacts. Git is the transport;
Canon is the contract agents use to share one codebase. The repo is still a normal Git repo and agents
still push. The only new object is the fact that decides whether a push becomes main.

**Main is not a branch. Main is the set of facts that must stay true of the running app.**

## Terms

- **Fact**: a sentence plus a check that can fail a preview. If it cannot fail a preview, it is not a fact.
  A fact works like a required status check in branch protection, except it checks behaviour on a live preview, not a lint script.
- **canon.json**: the facts, committed at the repo root. They travel with the code to GitHub, GitLab or a laptop clone.
  The referee only decides which world they currently point at.
- **Canon**: the facts currently true, plus a pointer to the world that makes them true.
- **Claim**: "agent-4 is trying to make *fact X* true." Agents coordinate by reading claims, not by locking files.
- **World**: one attempt. An Artifacts fork of the canon world, written to with a fork-scoped token.
  A person pushing by hand is just another world and gets the same verdict. Worlds are never deleted, so a
  world that failed a fact stays clickable: the failed worlds are the project's memory.
- **Referee**: one Durable Object per project. The only writer of facts, claims and the canon pointer.

## The four moves

### 1. Read

`GET /p/:project/canon`

```json
{
  "canon": { "worldId": "farmstand-genesis", "sha": "9f1c…", "seq": 1, "previewUrl": "https://…" },
  "facts": [{ "id": "price-is-listed", "sentence": "The basket charges the listed price for every unit", "status": "canon", "check": { … } }],
  "claims": [{ "agent": "agent-2", "factId": "no-double-booking", "status": "unproven", "verdict": { … } }]
}
```

### 2. Declare

`POST /p/:project/claims`

Propose a new fact:

```json
{ "agent": "agent-2", "why": "vendors keep fighting over stall 1",
  "fact": { "id": "no-double-booking", "sentence": "A stall cannot be double-booked", "check": { "kind": "probe", "steps": [ … ] } } }
```

Or race for a fact someone already proposed: `{ "agent": "agent-3", "why": "…", "join": "no-double-booking" }`.

The referee refuses a fact whose check already holds on canon (it is not new). On success it forks the canon world and returns:

```json
{ "claim": { "id": "c-…", "status": "open", … },
  "world": { "id": "farmstand-k3x9ab", "remote": "https://….artifacts.cloudflare.net/git/canon/farmstand-k3x9ab.git",
             "token": "…", "expiresAt": "…", "branch": "main" } }
```

The token can write to this fork only. Agents cannot push to canon.

### 3. Push

Plain Git: `git push origin main` inside the world. The Artifacts `pushed` event starts a Workflow that
builds the world as a Workers Preview (`wrangler preview --name <world>`) and asks the referee to judge it.

### 4. Verdict

`GET /p/:project/worlds/:id/verdict`

```json
{ "worldId": "farmstand-k3x9ab", "sha": "…", "previewUrl": "https://farmstand-k3x9ab-farmstand.….workers.dev",
  "outcome": "contradicts",
  "kept": ["market-lists-stalls", "products-have-prices", "cart-starts-empty", "unknown-product-refused"],
  "lost": [{ "factId": "price-is-listed", "detail": "step 2: totalCents is 4320, expected 4800" }],
  "claimed": { "factId": "bulk-discount", "held": true, "detail": "ok" },
  "offers": [] }
```

| outcome | meaning |
|---|---|
| `contradicts` | a canon fact broke on this world. Rejected without anyone opening the diff. |
| `unproven` | canon held; the claimed fact does not hold yet. |
| `behind` | would be ready, but canon gained a fact after this world forked. |
| `ready` | canon held and the claimed fact holds. A human decides. |

## canon.json

```json
{ "version": 1, "facts": [ { "id": "price-is-listed", "sentence": "The basket charges the listed price for every unit", "check": { … } } ] }
```

The referee judges every world with canon's facts, never with the world's own copy, so editing canon.json
cannot weaken a fact. A world's canon.json must equal canon plus the fact it claimed (`canon claim` adds it).

| world's canon.json | ledger | effect |
|---|---|---|
| canon + claimed fact | `ok` | judged normally |
| changes, drops or invents a fact | `tampered` | `contradicts` |
| lacks a fact accepted after the fork | `behind` | outcome `behind`; cannot be accepted; declare a fresh world |

Genesis is the exception: before any canon exists, the genesis world's own canon.json defines the facts, and
genesis becomes canon only when its preview satisfies all of them. Genesis can be an empty repo you push to,
or an import of an existing Git repo (`{"importUrl": "https://github.com/…"}`) that contains canon.json.

## Review and promotion

`POST /p/:project/claims/:id/accept`: a person accepts a change in the facts; the code comes along as evidence.
The referee freezes the world (revokes its write tokens), marks the fact canon, moves the canon pointer to the
world, deploys it to production, and re-judges every other live world against the new canon.
A world that now loses the accepted fact **contradicts** it. That is a conflict: a contradiction between worlds,
not a textual diff. Nothing is merged. If two good facts should both land, an agent declares a fresh world
that satisfies both.

## Why

`GET /p/:project/facts/:id/why` returns the fact chain: the world and claim that made the fact true
(with the agent's own "why"), and every world that failed it, each with its preview. Commits in a world carry
`Canon-Fact`, `Canon-Claim` and `Canon-Agent` trailers.

## Checks

One deterministic evaluator: HTTP steps against the preview with assertions.

```json
{ "kind": "probe", "steps": [
  { "method": "POST", "path": "/api/cart", "body": { "productId": "eggs", "qty": 12 }, "expect": { "status": 200 } },
  { "path": "/api/cart", "expect": { "json": { "totalCents": 4800, "items.length": 1 } } }
] }
```

`expect` supports `status` (number or list), `json` (dot-paths with array indices and `.length`;
`{"$exists": true}` asserts presence) and `bodyIncludes`. `save` captures values into `{{vars}}` for later steps.
Every check run sends a fresh `x-canon-run` header; the app scopes its state to it, so runs are isolated.
