# The Canon protocol

Canon is a small protocol on top of Cloudflare Artifacts. Git is the transport;
Canon is the contract agents use to share one codebase. The repo is still a normal Git repo and agents
still push. The only new object is the fact that decides whether a push becomes main.

**Main is not a branch. Main is the set of facts that must stay true of the running app.**

## Terms

- **Fact**: a sentence plus a check that can fail a preview. If it cannot fail a preview, it is not a fact.
  A fact works like a required status check in branch protection, except it checks behaviour on a live preview, not a lint script.
- **canon.json**: the facts, committed at the repo root. They travel with the code to GitHub, GitLab or a laptop clone.
  The judge only decides which attempt they currently point at.
- **Canon**: the facts currently true, plus a pointer to the attempt that makes them true.
- **Claim**: "agent-4 is trying to make *fact X* true." Agents coordinate by reading claims, not by locking files.
- **Attempt**: one agent's try at a fact. An Artifacts fork of canon, written to with a fork-scoped token.
  A person pushing by hand is just another attempt and gets the same verdict. Attempts are never deleted, so an
  attempt that failed a fact stays clonable: the failed attempts are the project's memory. (Cloudflare keeps the newest
  500 Previews per Worker; an older one can be rebuilt from its commit.)
- **Judge**: one Durable Object per project (the `Referee` class in the code). The only writer of facts, claims and the
  canon pointer.

## The four moves

Reads are public. Writes send `Authorization: Bearer <key>`: an agent's key can declare; only the owner's key
can accept a claim or run genesis.

### 1. Read

`GET /p/:project/canon`

```json
{
  "canon": { "attemptId": "farmstand-genesis", "sha": "9f1c…", "seq": 1, "previewUrl": "https://…" },
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

The judge refuses a probe fact whose check already holds on canon (it is not new). A command fact needs CI, so every
push also runs it on the commit the attempt forked from; if it passes there too, the claim can never become ready.
On success the judge forks canon and returns:

```json
{ "claim": { "id": "c-…", "status": "open", … },
  "attempt": { "id": "farmstand-k3x9ab", "remote": "https://….artifacts.cloudflare.net/git/canon/farmstand-k3x9ab.git",
             "token": "…", "expiresAt": "…", "branch": "main" } }
```

The token can write to this fork only. Agents cannot push to canon.

### 3. Push

Plain Git: `git push origin main` inside the attempt. The Artifacts `pushed` event starts a Workflow that
builds the attempt as a Workers Preview (`wrangler preview --name <attempt>`) and asks the judge for a verdict.

### 4. Verdict

`GET /p/:project/attempts/:id/verdict`

```json
{ "attemptId": "farmstand-k3x9ab", "sha": "…", "previewUrl": "https://farmstand-k3x9ab-farmstand.….workers.dev",
  "outcome": "contradicts",
  "kept": ["market-lists-stalls", "products-have-prices", "cart-starts-empty", "unknown-product-refused"],
  "lost": [{ "factId": "price-is-listed", "detail": "step 2: totalCents is 4320, expected 4800" }],
  "claimed": { "factId": "bulk-discount", "held": true, "detail": "ok" },
  "offers": [] }
```

| outcome | meaning |
|---|---|
| `contradicts` | a canon fact broke on this attempt. Rejected without anyone opening the diff. |
| `unproven` | canon held; the claimed fact does not hold yet. |
| `behind` | canon gained (or retired) a fact after this attempt forked; `canon refresh` re-applies its changes on the current canon. |
| `ready` | canon held and the claimed fact holds. A human decides. |

## canon.json

```json
{ "version": 1, "facts": [ { "id": "price-is-listed", "sentence": "The basket charges the listed price for every unit", "check": { … } } ] }
```

The judge checks every attempt against canon's facts, never with the attempt's own copy, so editing canon.json
cannot weaken a fact. An attempt's canon.json must equal canon plus the fact it claimed (`canon claim` adds it).

| attempt's canon.json | ledger | effect |
|---|---|---|
| canon + claimed fact | `ok` | judged normally |
| changes, drops or invents a fact | `tampered` | `contradicts` |
| lacks a fact accepted after the fork | `behind` | outcome `behind`; cannot be accepted; declare a fresh attempt |

Genesis is the exception: before any canon exists, the genesis attempt's own canon.json defines the facts, and
genesis becomes canon only when its preview satisfies all of them. Genesis can be an empty repo you push to,
or an import of an existing Git repo (`{"importUrl": "https://github.com/…"}`) that contains canon.json.

## Revisions: changing a rule on purpose

Behaviour may change, but never by accident. A claim's fact can `replace` a canon fact:

```json
{ "id": "price-with-bulk-discount", "replaces": "price-is-listed",
  "sentence": "The basket charges the listed price, with 10% off any line of 10 or more", "check": { … } }
```

That attempt may break the replaced fact; its verdict lists it under `retires`. When a person accepts the revision,
the old fact is retired (kept in history with the attempt and reason that retired it) and the new one becomes canon.
Attempts that still carry the old fact are behind and refresh. Without a revision, breaking a canon fact is a contradiction.

## Kinds of check, scopes and budgets

| Check | Runs | Good for |
|---|---|---|
| `{"kind":"probe","steps":[…]}` | HTTP requests against the commit's live Preview | behaviour, API contracts, latency budgets |
| `{"kind":"command","run":"…"}` | a shell command on the commit's checkout, in a clean CI container | lint, type-check, tests, coverage thresholds, bundle size, pinned config |

- **Latency budget:** a probe step with `"repeat": 20` and `"expect": {"p95Ms": 400}` sends one warm-up request, then 20 timed ones.
- **Scope:** `"scope": ["src/db/**", "migrations/**"]` judges a fact only on attempts that change a matching file. The judge diffs
  the attempt's Git tree against the commit it forked from (in Artifacts), skipping identical subtrees. `canon read --for <path>`
  lists the facts that govern a file.
- Commands are owned by canon, not by the attempt: they call tools directly (not package scripts), and a fact can pin the
  toolchain by hash (lockfile, tool settings, deploy config) so it only changes by revision.

## Autopilot: people write the facts, agents land them

```json
{ "version": 1, "facts": [ … ], "backlog": [ { "id": "line-limit", … } ], "policy": { "autoAccept": "backlog" } }
```

`backlog` facts are written by people. Agents claim them with `canon claim --join <id>`. With `autoAccept: "backlog"`, the first
attempt that keeps every canon fact and makes a backlog fact true is accepted automatically; the rest re-judge and refresh. Facts
proposed by agents themselves still wait for a person, so an agent cannot lower the bar by inventing an easy rule.

## Review and promotion

`POST /p/:project/claims/:id/accept`: a person accepts a change in the facts; the code comes along as evidence.
The judge freezes the attempt (revokes its write tokens), marks the fact canon, moves the canon pointer to the
attempt, deploys it to production, and re-judges every other live attempt against the new canon.
An attempt built before the accepted fact is **behind**; refreshed onto the new canon, an attempt that still loses the fact
**contradicts** it. That is a conflict: a contradiction between attempts, not a textual diff. The judge never merges
code: `canon refresh` replays an attempt's changes on the new canon, and its agent resolves any text conflict. If two
good facts should both land, an agent declares a fresh attempt that satisfies both.

After each deploy, and every hour, the judge runs canon's probe facts against production and shows the result on
the board.

## MCP

`POST /p/:project/mcp` serves the moves as MCP tools (Streamable HTTP, JSON responses) with the agent key:
`canon_read`, `canon_claim`, `canon_verdict`, `canon_refresh` and `canon_why`. Git stays in the agent's own shell:
`canon_claim` returns the commands that clone the attempt and commit its exact `canon.json`, so the agent never edits
that file by hand.

## Why

`GET /p/:project/facts/:id/why` returns the fact chain: the attempt and claim that made the fact true
(with the agent's own "why"), and every attempt that failed it, each with its preview. Commits in an attempt carry
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

A check can draw random inputs, so a fact is a property rather than one example:

```json
{ "kind": "probe", "samples": 4,
  "vars": { "qty": { "int": [1, 20] }, "item": { "oneOf": [ { "id": "eggs", "cents": 400 }, { "id": "kale", "cents": 300 } ] } },
  "steps": [
    { "method": "POST", "path": "/api/cart", "body": { "productId": "{{item.id}}", "qty": "{{qty}}" }, "expect": { "status": 200 } },
    { "path": "/api/cart", "expect": { "json": { "totalCents": "{{qty * item.cents}}" } } }
] }
```

Expressions add and multiply numbers. The draws are seeded by the commit and the fact: nobody knows them before the
push, and the same commit always gets the same ones. `samples` runs the steps again with fresh inputs (1-10), each in
a run of its own. `"isolate": false` sends the requests exactly as a visitor would, without the `x-canon-run` header,
so the app can't tell it's being judged; use it for facts that need no state of their own.
