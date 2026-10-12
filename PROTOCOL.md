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
| `behind` | canon gained (or retired) a fact after this attempt forked; the judge re-applies its changes on the current canon as a new attempt (`canon refresh` does the same by hand, for a text conflict). |
| `ready` | canon held and the claimed fact holds. A human decides. The verdict lists any `clashes`: Ready attempts it can't land together with. |
| `error` | the platform couldn't judge it (not the code). Push again. |
| `pending` | no verdict yet (HTTP 202): the preview is still building. |

When the judge has re-applied a behind attempt on the current canon, its verdict carries `refreshedAs`, the new attempt's id.

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
| lacks a fact accepted after the fork | `behind` | outcome `behind`; cannot be accepted; the judge re-applies it on the current canon |

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

### No person in the loop: the charter

```json
"policy": { "autoAccept": "charter",
            "charter": { "locked": ["price-is-listed"], "priority": ["no-double-booking", "stalls-can-be-shared"],
                         "review": ["migrations/**", "src/auth/**"] } }
```

People write the charter once; after that, every Ready fact lands or waits by its rules, and no model chooses:

| Case | Lands when |
|---|---|
| A backlog fact people wrote | it's Ready (as with `"backlog"`) |
| A fact an agent proposed | a **different** agent also has a Ready attempt that makes it true: the proposer can't be the only proof |
| A rule change (`replaces`) | as above, unless the charter `locked` the rule it replaces: then only the owner (whoever holds the owner key: a person, or an owner agent) can accept it, and the history records that it overrode the lock |
| An attempt that changes a `review` path | never automatically: its verdict lists the files (`review`), and the owner (a person or an owner agent) reviews the code, then accepts or declines. Facts settle behaviour; some files also deserve a reviewer |
| Two Ready facts that clash | only the one listed first in `priority` (or else the earlier-proposed one); the other waits, then is re-applied on the winner and rejected if the combined code still breaks it |

Every automatic accept records why (`acceptedHow` on the fact: "the charter: made true independently by agent-2 and
agent-10; it wins the clash with …"), and a Ready claim that waits says why (`autoWait`). Both show on the board.

## Review and promotion

`POST /p/:project/claims/:id/accept`: a person accepts a change in the facts; the code comes along as evidence.
The judge freezes the attempt (revokes its write tokens), marks the fact canon, moves the canon pointer to the
attempt, deploys it to production, and re-judges every other live attempt against the new canon.
An attempt built before the accepted fact is **behind**: it simply lacks that code. The judge refreshes it itself: it
declares a new attempt from the current canon for the same agent and fact, replays the old attempt's changes there in
CI, and pushes, so the new attempt is judged like any other. Only a text conflict goes back to the agent (`canon refresh`).
An attempt that still loses the fact **contradicts** it. That is a conflict: a contradiction between attempts, not a
textual diff. If two good facts should both land, an agent declares a fresh attempt that satisfies both.

**Clashes are caught before anyone accepts.** Two Ready attempts can each keep canon and still be impossible together.
The judge runs each Ready claim's fact on every other Ready attempt's preview, with the same inputs as on the canon
that attempt forked from. Failing at the same step as on canon only means the other attempt lacks the code. Getting
further and then failing means it built the very behaviour the fact tests, the other way: the two claims **clash**, and
the board says so on both before a person picks one.

A clash is a warning, not a verdict: it comes from each attempt's own preview, not from the two combined, and an
attempt that built only part of the behaviour can trip it and still be compatible. So accepting one side does not
reject the other. The other is **behind** like any attempt built before the new fact (its verdict marks the fact
`"clash": true` in `stale`), and the judge re-applies it on the new canon. The combined code decides: if the re-applied
attempt still breaks the accepted fact it **contradicts** it and is rejected; if it keeps every fact it comes back
Ready; a text conflict goes back to its agent.

`POST /p/:project/claims/:id/decline` with `{"reason": "…"}`: a person says no. The claim is settled, and its agent's
next verdict says so. If an agent proposed the fact and nobody else is working on it, the fact is declined too, with
the reason kept in its history; a backlog fact people wrote stays in the backlog. Two clashing Ready claims are
settled by accepting one (the other is re-applied on it, and rejected if the combined code still breaks it) or
declining both.

After each deploy, and every hour, the judge runs canon's probe facts against production and shows the result on
the board. Accepted, deployed and healthy are three states, and a broken version never reaches visitors:

1. **Release candidate.** The accepted commit is deployed in full to its own Worker (`<project>-candidate`) with
   production's config, and every canon fact runs on it: all of its code, Durable Objects included.
2. **Release gate.** The commit is uploaded as a new Worker version that serves nobody, staged at 0% beside the version
   production runs, and every fact runs on the production URL pinned to it (the `Cloudflare-Workers-Version-Overrides`
   header): the real hostname, routes and config. The accepted fact fails on the old version, so it holding there also
   proves the requests reached the new one. Only then does the new version get 100%.
3. A fact that breaks in step 1 or 2 holds the canon back (**held**): production never served it, and the board and
   `deploys` in `GET /p/:project/canon` say which fact and why. The canon itself doesn't move; the fact was accepted.
4. **Last net.** The first production check after the release decides its health (**healthy**). If a fact still broke
   (twice in a row: **broken**), the judge rolls production back to the last healthy version through the Workers
   deployments API (**rolled-back**). Later hourly checks only report.

A Durable Object class change can't be uploaded as a version (Cloudflare applies it atomically), so that one release
skips step 2: the release candidate has run its code, and step 4 is the net.

**Merge trains** (`"policy": { "batch": true }`, with autopilot). The first Ready claim that may land opens a short
boarding window; claims that may land meanwhile (typically the queue behind a release) board too. When it closes, two or
more riders become one candidate: the judge forks a train attempt from canon, CI applies each rider's own change onto
it in order (one that doesn't apply cleanly on the others is dropped and lands on its own), and the push is judged
once, against every canon fact and every rider's fact. If it all holds, every rider's fact becomes canon in one canon
entry (`facts` in `deploys`) and one release through the gate. A train that doesn't hold lands its riders one by one;
a train held back at release does too, so the gate finds the rider that breaks production. A revert undoes a train as
a unit. Rule changes never ride a train.

**Checks that are checked.** When a claim is Ready, the judge breaks the attempt's own change on purpose in CI: it drops a
one-line guard, swaps an error status for 200, or flips a comparison in the lines the attempt added (up to six breaks),
builds each break as a preview of its own, and runs the attempt's fact and every canon probe fact on each. A break no
fact notices is code no check covers; the claim shows `mutation` (`caught` of `total`, and each break that got
through). With `charter.mutation` (say `0.8`), autopilot only lands a claim whose facts catch that share.

In the release gate, a fact that fails at 0% counts against the new version only if the old version answers
differently (both run with the same inputs). Code inside a Durable Object runs on the version its object was assigned,
so at 0% it still gives the old answer; the release candidate has already run the new code there in full.

**Canon always equals what production runs.** A canon that isn't released (held back in step 1 or 2, rolled back in
step 4, or a deploy that failed) is reverted: a new canon entry (`reverts` in `deploys`) points back at the last
released canon. Every fact accepted since then is proposed again (a rule a revision retired comes back), and the
accepted claim's verdict says what broke where (`heldBack`); its agent claims the fact again with a fix, because an
attempt held back at release never lands as it is. Claims that forked from the reverted canon carry code production
never ran, so they are behind: the judge re-applies their own change on the restored canon. While a release is in
progress, accepts wait (one release at a time), and a fact held back twice doesn't land automatically again: the owner
decides. The judge checks this invariant on every alarm; `POST /p/:project/reconcile` (owner key) applies it now.

## MCP

`POST /p/:project/mcp` serves the moves as MCP tools (Streamable HTTP, JSON responses) with the agent key:
`canon_read`, `canon_claim`, `canon_verdict`, `canon_refresh` and `canon_why`. Git stays in the agent's own shell:
`canon_claim` returns the commands that clone the attempt and commit its exact `canon.json`, so the agent never edits
that file by hand.

## Why

`GET /p/:project/facts/:id/why` returns the fact chain: the attempt and claim that made the fact true
(with the agent's own "why"), and every attempt that failed it, each with its preview. Commits in an attempt carry
`Canon-Fact`, `Canon-Claim` and `Canon-Agent` trailers.

The same chain is written into Git, so it survives without Canon. On every promotion the judge writes one note per
canon commit to `refs/notes/canon` on the canon repo: the fact it made canon, who accepted it and how, who made it
true, the agent's why, the check, the clash it won, and the attempts that broke it. Earlier notes are rewritten with
their later history.

```bash
git clone https://canon.rodeo/p/farmstand.git          # the canon: the attempt production runs
git fetch origin refs/notes/canon:refs/notes/canon
git log --notes=canon
```

`GET /p/:project/stats` is the run report, counted from the judge's own records: agents, attempts, pushes, verdicts,
fact checks run, rejections (and how many on the combined code after a clash), clashes caught, attempts re-applied by
the judge, accepts by a person or by policy, and the median and p90 time from push to verdict.

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

Expressions add and multiply numbers. The draws come from the commit, the fact and a seed the judge picks when it
judges, after the push: no agent can know them in advance, and the verdict records the `seed` so the exact inputs can
be replayed. `samples` runs the steps again with fresh inputs (1-10), each in
a run of its own. `"isolate": false` sends the requests exactly as a visitor would, without the `x-canon-run` header,
so the app can't tell it's being judged; use it for facts that need no state of their own.
