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
builds the attempt as a Workers Preview (`wrangler preview --name <attempt>`), runs the command facts beside it (both
start from the same installed snapshot and don't need each other), and asks the judge for a verdict.

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

A verdict that isn't Ready carries a `diagnosis`: what kind of failure it is and what would resolve it.
`implementation` (the change breaks a canon fact, or its own fact doesn't hold yet), `combination` (it held on its own
base and breaks only together with what became canon since; or it's behind and being re-applied), `requirement` (its
fact already held before the change, or at least two other attempts fail it with the same assertion: the fact may be
wrong, and only a person changes it), `unsupported-check` (held back at release because the evidence it needs couldn't
be produced, such as a fact that writes with no read-back), or `infrastructure` (the platform failed; the judge
retries). It is guidance for whoever acts next; the facts still decide.

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
- **Races:** a probe step with `"concurrent": 6` sends six copies at the same moment (each may use `{{i}}`, 0 to 5, to
  differ), and `"expect": {"statusCounts": {"201": 1, "409": 5}}` says how the answers must add up: exactly one booking
  wins. A sequential "book twice, the second gets 409" passes a check-then-insert with an await in between; the race
  doesn't (`scripts/test-probe.ts` shows both). The backlog's double-booking fact (`agents/canon.autopilot.json`) carries one.
  Every response of a concurrent or repeated step is held to the step's `json` and `bodyIncludes` too; `save` (which
  needs one response) and `p95Ms` on a step that isn't repeated are refused when the fact is declared, so no assertion
  a fact declares is ever silently skipped.
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
CI, and pushes, so the new attempt is judged like any other. A text conflict gets one bounded repair first: the
judge's model resolves the conflict markers, told what both sides' facts are; the resolution must leave no markers and
keep every line outside the conflicts, and is then pushed and judged on every fact like any push (`refresh: repaired`
on the claim). A resolution that fails those checks, or a fact, goes back to the agent (`canon refresh`), who is no
worse off than with the conflict. An attempt that conflicted gets one more re-apply each time canon moves on.
An attempt that still loses the fact **contradicts** it. That is a conflict: a contradiction between attempts, not a
textual diff. If two good facts should both land, an agent declares a fresh attempt that satisfies both.

**Clashes are caught before anyone accepts.** Two Ready attempts can each keep canon and still be impossible together.
The judge runs each Ready claim's fact on every other Ready attempt's preview, with the same inputs as on the canon
that attempt forked from. Failing at the same step as on canon only means the other attempt lacks the code. Getting
further and then failing means it built the very behaviour the fact tests, the other way: the two claims **clash**, and
the board says so on both before a person picks one.

**And earlier, while agents are still writing.** The same comparison runs as soon as either attempt is *unproven*
(canon holds, its own fact doesn't yet): every push is judged, so work in progress has a preview too. A finding there
is a **heads-up** (`headsUp` in the verdict, `HEADS-UP` in `canon verdict` and on the board) to both agents: one of
them is building the other's fact the opposite way. Neither is Ready, so nothing is decided; it gives an agent the
chance to change course (or say why in its claim) while the cost is a few edits, not a lost attempt. Once both are
Ready, the same finding is a clash.

Even before a push, `canon overlap` (`POST /p/:project/overlaps` with `{attempt, paths}`, or MCP `canon_overlap`)
answers "who else is changing my files?": the judge adds what the attempt already pushed to the paths the agent has
changed locally, and lists every other attempt in flight that changed any of them, with the fact it is building. It
goes down to functions: the agent's working copy and each other attempt's push are diffed against the canon they forked
from, so "agent-2 is changing `Market.addToCart`, which you are changing too" comes first, and agents who only share
the file are folded into one line. Calls count too, in any file: "agent-1 is changing `Market.addToCart`, which your
change calls", or the other way round.
Overlapping files are often fine (behaviour decides, not text); it lets agents talk before either has a preview.
Agents run by `agents/run.sh` don't have to remember to ask: a Claude Code hook (`agents/hooks/overlap.mjs`, a
PostToolUse hook on every edit) runs it and puts the answer in the agent's session when another agent is changing a
function this edit touches (and says nothing for agents who merely share the file).

A clash is a warning, not a verdict: it comes from each attempt's own preview, not from the two combined, and an
attempt that built only part of the behaviour can trip it and still be compatible. So accepting one side does not
reject the other. The other is **behind** like any attempt built before the new fact (its verdict marks the fact
`"clash": true` in `stale`), and the judge re-applies it on the new canon. The combined code decides: if the re-applied
attempt still breaks the accepted fact it **contradicts** it and is rejected; if it keeps every fact it comes back
Ready; a text conflict is repaired by the judge if it can be, and otherwise goes back to its agent.

`POST /p/:project/claims/:id/decline` with `{"reason": "…"}`: a person says no. The claim is settled, and its agent's
next verdict says so. If an agent proposed the fact and nobody else is working on it, the fact is declined too, with
the reason kept in its history; a backlog fact people wrote stays in the backlog. Two clashing Ready claims are
settled by accepting one (the other is re-applied on it, and rejected if the combined code still breaks it) or
declining both.

After each deploy, and every hour, the judge runs canon's probe facts against production and shows the result on
the board. Accepted, deployed and healthy are three states. A version that breaks a fact on the release candidate never reaches visitors, and one that breaks in
production anyway is rolled back:

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

Step 2 needs a Worker without Durable Objects. An object runs one version at a time, so at 0% the staged Worker talks
to the old objects and its answers mean nothing (in practice they fail even when the new code is right). For a Worker
with Durable Objects, step 1 is the gate: a full copy with production's config and its own persistent data, which is
also what catches a schema change that only breaks on existing data. Step 4 stays the last net.

**Merge trains** (`"policy": { "batch": true }`, with autopilot). The first Ready claim that may land opens a short
boarding window; claims that may land meanwhile (typically the queue behind a release) board too. When it closes, two or
more riders become one candidate: the judge forks a train attempt from canon, CI applies each rider's own change onto
it in order (one that doesn't apply cleanly on the others is dropped and lands on its own), and the push is judged
once, against every canon fact and every rider's fact. If it all holds, every rider's fact becomes canon in one canon
entry (`facts` in `deploys`) and one release through the gate. A train that doesn't hold (on its combined preview, or
held back at release) doesn't say which rider broke it: four or more riders split in two halves, each its own train at
the next departures (`half` in `trains`), and a half that fails splits again; fewer land one at a time. A train of eight
narrows a failure down in about three checks instead of eight. Splitting is diagnosis, not a verdict on one rider: each
half lands on top of what landed before it, so a failure that only appears when two riders combine shows up when the
second is checked on top of the first, and the attempt held back is told what broke on the combined code, not that it
alone is to blame (the "held back twice" valve counts only releases where a fact went out alone). A revert undoes a
train as a unit. Rule changes never ride a train.

**Admission.** A project verifies at most six pushes at a time; the rest wait in their own Workflow and start as slots
free (a slot frees when the judge gets the result, or after 15 minutes). Turns are fair and value-aware: a free slot goes to the
waiting agent with the fewest builds already running, then to the most valuable fact (one the charter ranks in
`priority`, then one people wrote in the backlog), then to the one waiting longest, so one agent pushing a lot can't
starve the others and what people asked for comes first. A queued push whose attempt has since pushed again is dropped: its verdict would be replaced at once. In a load test of 30 simultaneous pushes, no
limit made the CI runner fail, ten let platform retries back the queue up, and six gave every push a real verdict in
under four minutes (median 115 s); 4 and 8 were both slower, and 60 pushes at six took under 11 minutes for the last.
A latency budget that fails under load is compared with canon's own preview at the same moment: if canon misses it
too, the verdict is a platform error (retried), not a rejection. Waiting never turns into permission: a push not
admitted in about three and a half hours isn't verified at all; it gets a platform error, which the judge retries. A
verification that a newer push of the same attempt has made pointless stops as soon as its preview is built, before
any check runs, and gives its slot back. Projects share the account's capacity too: a verification needs a slot in its
project (six) and an account-wide slot (twelve, in one Durable Object), and a free account slot goes to the project with
the fewest verifications running, then the longest wait, so one busy project can't starve the rest. Deliberate-break
runs are background work: besides their per-project cap (two at a time), they take an account slot only while no
verification is waiting for one and the account is under half its capacity, and they never join the queue, so they
can't delay a verification; the judge asks again on its next alarm.

**Speculative trains.** A train doesn't wait for the release in front of it. Claims that become Ready while a release
runs board for 3 seconds, then leave as a train built on the canon being released (`speculative` in `trains`): it is
built and checked while that release goes out. A train checked before the release finishes waits (`waiting`), then
lands the moment the release is out, without a second check, because it was checked on exactly what production now
runs. If the release is held back, the train's base is gone: it fails, and its riders land one at a time.

**Checks that are checked.** When a claim is Ready, the judge breaks the attempt's own change on purpose in CI, in the
lines the attempt added, up to eight breaks, the ones a happy-path check is likeliest to miss first: a repeated write
that overwrites instead of adding, a duplicate that replaces or is silently dropped (`INSERT OR IGNORE`/`OR REPLACE`),
a dropped uniqueness constraint (two writers could both win), a migration that isn't safe to re-run or gives existing
rows no default, a swallowed `throw` or a removed failing check; then a dropped one-line guard, an error status
swapped for 200, a flipped comparison. It builds each break as a preview of its own, and runs the attempt's fact and every canon probe fact on each. A break no
fact notices is code no check covers; the claim shows `mutation` (`caught` of `total`, and each break that got
through). With `charter.mutation` (say `0.8`), autopilot only lands a claim whose facts catch that share.

**A second pair of eyes.** Once a Ready claim's checks are tested, a model that didn't write the change (Kimi K2.7 Code
on Workers AI; the agents are Claude or Grok) reads it: the fact it claims, the facts it must keep, the breaks no fact
caught, and the lines it added. It writes at most three notes (`risk`, `untested`, or `intent`: beyond what the fact
asks), and each must quote the exact line it is about; a note whose quote isn't in the file is dropped and counted.
Specialists: a change that touches stored data (or couldn't be inspected) also gets a data pass (migrations, whether the
previous version can read what this one writes, lost or non-idempotent writes), and one touching authentication,
permissions, secrets or a charter `review` path a security pass; each note says which pass wrote it. The notes
(`reviewer` on the claim and the verdict, `REVIEWER` in `canon verdict`) are advice for whoever decides,
never a verdict: the facts decide, the reviewer only points. The owner can ask for a fresh review with
`POST /p/:project/attempts/:id/review`. With `"reviewRisk": true` in the charter, the reviewer becomes a gate in one
direction only: a change it flags with a `risk` note waits for the owner instead of landing on autopilot (it can
never land or reject anything itself). A model's reviews vary from run to run, so a risk named on an attempt stands on
every re-apply of it until an agent changes the code: the judge re-applying the same change can't clear it by drawing
a kinder review. A review that never finishes (a deploy can cut one off) is retried once; after that it is unavailable.
Only a complete answer in the notes format counts as a review: an empty list of notes is a finding ("nothing to
flag"), but an answer that was cut off, isn't the notes format, has any entry that isn't a whole note (file, line,
quote, kind, note) is an error (unavailable), never a clean review. A risk or intent finding the reviewer can't quote
from the change isn't a confirmed violation, but it isn't resolved either: it's kept as `unresolved` on the review, and
required review evidence over it is unavailable (the owner decides), while an advisory review just shows it. Not
knowing which files changed is an error too (never "no source files changed"). Nothing is cut to fit: every changed
source file is shown with its added lines and its removed lines (a guard taken out is part of the change), whole, or
around every change, added or removed, when it's too big to show whole, packed into as many passes as that
takes (`coverage` on the review says how many, and which files were shown around their changes). The diff is
order-sensitive: lines the two versions share at the start and end are set aside, and the rest is a line diff, so a
validation moved from before a storage write to after it shows up as a removal and an addition, even in a 4,000-line
file. A file whose changed region is too large to diff, or too big to show even around each change, is left out and
named (`coverage.omitted`): the other files are still reviewed as advice, but required review evidence is unavailable.
More than twelve files makes the review unavailable and the owner decides. Findings that can decide acceptance
(every risk, and every intent finding) are never dropped to make room, within a pass or across passes; only
"untested" notes are capped for display. `/stats` keeps the reviewer's track record, overall and per specialist, from what happened to the
changes it read: risks confirmed (that attempt later broke a fact), overruled (a person accepted it and its release
stayed healthy), and missed (no risk named, and the accepted change broke a fact at release or in production). With
`"intentRisk": true`, an `intent` note (the change does something its fact doesn't ask for) waits for the owner too.

**Required evidence is required.** Each piece of evidence the charter asks for has an explicit state: `passed`,
`failed`, `unavailable`, `not-applicable`, `not-required` or `pending` (`referee/src/evidence.ts`). The gates are
non-compensatory: autopilot lands a claim only when every required piece passed, or the judge established there was
nothing to check (`not-applicable`: the change touches no source file, or adds no line the mutator can break; never
a failure assumed away). A check that didn't run is `unavailable`, not a pass: deliberate breaks that couldn't be
built, a mutation run or review that timed out or errored, a review the charter requires with no model to ask, a
command fact (deliberate breaks are judged by probe facts only), or a commit whose changed files couldn't be read
while the charter has `review` paths. Autopilot then waits and says why; only the owner can accept over it, and the
accept names the exception. Data is always required of autopilot, and the judge keeps three questions apart.
Did it read every changed file that could hold data code (code in any JS/TS flavour, SQL, config; up to 60 files, and
a failed read is told apart from a deleted file)? If not, the data evidence is unavailable and the owner decides. Do
the added lines destroy stored data (drop or rename a table or column, even on an interpolated name; delete or rename a
Durable Object class)? Then it waits for the owner, because rolling a Worker back doesn't bring data back. Anything
else lands, and no release is called rollback-safe until it has rehearsed the rollback (below): patterns can't prove a
change leaves stored data alone (a new value passed to an old helper changes what's stored), so they only decide which
evidence is needed. A file too big for the exact line diff is still read in full (lines are counted, so every new
line is found; a big file never reads as "nothing added"), and data inspection keeps its own cache of strict reads,
apart from the advisory overlap reads.

**Scope.** A claim may declare the files it will change (`touches`, globs; `canon claim --touches`). Declared, the
verdict lists anything changed outside it (`outside`), the agent sees OUTSIDE YOUR SCOPE, and autopilot leaves it to
the owner: passing a fact doesn't excuse an unclaimed edit. Undeclared, scope is not required, unless the charter says
`"requireScope": true`, and then every claim must declare it.

**Prerequisites.** A claim may name the facts it builds on (`after`; `canon claim --after`): it isn't landed until they
are canon (autopilot says which one it's waiting for, and an owner who accepts early accepts over it, recorded), and
its pushes are admitted after everything else, since it can't land yet. When a prerequisite lands, the claim is behind
and the judge re-applies it on top, as with any canon move.

**Held-out facts.** The owner can add facts straight to the judge (`POST /p/:project/heldout`, owner key), never to
`canon.json`: they're enforced on every verdict, release and mutation run like any canon fact, but agents and the public
board see only the sentence, never the check, and a failure says only that a held-out fact broke. A probe must hold on
canon when it's added. An agent can't tune its code to a check it can't read, or edit one it can't see.

**The acceptance record.** When canon moves, the judge writes what exactly was authorized, in the same write as the
canon pointer: the commit, the canon its verdict was judged on, each fact it lands with a version of its check, the
commit and seed that made it true, its evidence (mutation, review, data, each with its state and why), who or what
authorized it (the owner, or the autopilot reasons), any exception a person accepted over, the policy that allowed
it (the charter as stored, and a version of it), the other attempts at the same facts and what became of them (the
alternatives it passed over, with a person's reason when they declined one), why this one was chosen (`chosenBecause`: the
rule that chose it, or the owner's own words, `POST .../accept` with `{"reason"}`), how a failed release recovers, and,
for a gradual rollout, each step and what it saw. `GET
/p/:project/canon/:seq/acceptance` returns it, the board links it, and the Git note on that canon commit carries it.

**The release fence.** The judge is the only writer of production's deployment: the release run uploads the exact commit
as a Worker version that serves nobody (Durable Object apps too; only a Durable Object class change, and a project's very first
release, when its production Worker doesn't exist yet and there's nothing to stage beside, deploy directly from the run), and the judge puts it in front of traffic. Every deployment write checks the lease in the
same turn, right before the request, and a run that has lost it writes nothing at all, not even a rollback or cleanup:
putting production right is the judge's own reconciliation, which, whenever no release holds the lease, sets
production's deployment to canon's released version from the deployment as it is now (a 0% version a fenced-out run
left staged, say). Ownership comes from the lease itself, whoever holds it: a release, or a republish of a canon that
is already released (whose canon row says "deployed", so a pending row alone would miss it), and for a while a release
that was accepted but hasn't started its run. The judge's own writes (reconciliation, an automatic rollback, undoing a
fenced-out run's change) recheck that nobody owns production, in the same turn as the request and with no await
between: a release or republish that took the lease while the judge was waiting on the network owns production, and
the judge backs off. Writes are ordered through per-write records in the judge's storage. Judge writes are serialized:
a new one waits until no earlier judge write is outstanding, then, in the same turn as it registers and sends, rechecks
who owns production. Each write's record is settled only by its own answer; when its outcome is unknown (a timeout, a
lost connection, the judge evicted mid-request), that record is held for a two-minute quarantine, and no other write's
answer can clear it. Every production-changing step of a release or republish run passes the fence first, and the
fence waits until no judge write is outstanding, checks again after every wait (a judge write may register while it
waits), and only then validates authority and grants the lease, in one turn with no await; so do the gate's own
writes. A judge write and a fence started together therefore have two possible outcomes: the write registers first
and the fence waits for it, or the lease is granted first and the write sees it and sends nothing. That covers the direct-deploy paths too
(a Durable Object class change, a project's first release). The quarantine is a bounded-risk policy, not proof: a
client timeout isn't a cancellation, and Cloudflare documents no completion bound for a deployments request, so after
two minutes a write that never answered is presumed not to land. Only an answer counts as confirmed settlement.
Method-level tests drive the real write, fence and gate methods with hand-answered requests
(`scripts/test-judge-writes.ts`). Every wrangler call that
changes a Worker recomputes the time left on the lease's absolute deadline right before it runs, refuses to start with
less than a minute left, and runs under `timeout` to it, even inside a script that first clones and installs. The release Workflow consumes the record, and holds the release as a lease. Its first step asks
whether this exact commit is what canon #seq authorized and whether #seq is still the latest canon; a stale or
unauthorized candidate is refused (nothing deploys, and canon goes back). The lease lasts 15 minutes and is renewed
before every step that changes a Worker (the release candidate, the rollback rehearsal, the version upload, the gate,
production), and each of those container commands checks the lease's deadline itself before it runs, so a step that
starts late refuses itself. A run that stalls past its lease is fenced out: the judge settles the release without it
(asking production what it actually runs) and refuses its every later step, the 0% gate checks the lease before each
deployment change, and if a fenced-out run still reports a production change, production is put back on the version
canon says it runs. Authorization is checked at every production-changing step, not only at the start.

**Rollback rehearsal.** Every release rehearses its own rollback before production (patterns can't prove a change
leaves stored data alone): after the release candidate passes (this release's code, running on
the candidate's long-lived data), the code production runs now is deployed onto the candidate, over the data the new
code just wrote, and the facts that were canon before must still hold (the new fact must fail there first: proof the
old code is the one answering). Then state continuity, with fixture creation kept apart from the compatibility
check (the **fixture contract**). The release's code ran every stateful fact once more, in full, with a fixed seed,
under an identity of its own and under one shared identity, writing the fixture, and Canon kept what each run needs to
find its state again: the drawn inputs and every value a step saved (a generated id, say). The old code writes its own
control fixtures the same way. Then the old code only reads: each fact's GET steps, on top of the values the fixture's
writer saved, against its own control first and then against the new code's fixture. Reading never repairs, replaces
or clears a fixture, and a retry reads the same one again. Every fact gets an outcome, recorded as `coverage` in the
acceptance record: **compared** (the old code reads both), **incompatible** (it reads its own control but not what the
new code wrote: the rehearsal fails), **inconclusive** (a fixture couldn't be written, or the old code can't read even
its own: unavailable), **unsupported** (it writes state and has no GET step to read it back with: unavailable, and the
record says what to add), or **not applicable** (every write it makes is expected to be refused, or its owner declared
`"fixture": "none"` on the check). Missing evidence is never a pass, and zero comparisons isn't evidence either: a
rehearsal that compared nothing is unavailable, unless the release's Wrangler config has no storage bindings at all
(no Durable Objects, D1, KV, R2, Hyperdrive, Vectorize, Queues or Workflows) **and** the owner declares in canon.json
that the app keeps no persistent state anywhere (`"policy": { "state": "none" }`), because a Worker can write an
external database over HTTP that no config shows. Either one alone leaves statefulness unknown. The record names the
basis ("on the owner's declaration"), so a declaration is never mistaken for something the judge found. A passed rehearsal covers the state and
facts it exercised, not every dataset production may hold.
Passed: rollback is known safe, and the record says so. Failed or unavailable (the old
code couldn't be deployed, e.g. a Durable Object migration that can't be undone): autopilot holds the release back,
because it doesn't release what it can't take back; a person's accept still goes out, with rollback marked unsafe and
`recovery.override` in the record naming who released it over which rehearsal result. And
when a release that touched stored data doesn't ship (held back, rehearsal failed, any failure after its code ran on the
candidate), the run rebuilds the release candidate from production's code before it lets go of the release: the
candidate Worker is deleted with its Durable Objects and production's code deployed fresh, so no later release is
judged on data in a shape production never had (found live: one held-back migration otherwise held back the next,
correct, release too). A candidate that couldn't be rebuilt (the rebuild failed, or the run was fenced out first) is
marked dirty, and the next release rebuilds it from production's code before deploying its own, or stops there as a
platform failure: a dirty candidate is never reused as it is.

**Gradual rollout.** For a Worker without Durable Objects (where any request may land on either version), after the 0%
smoke test the judge rolls the version out in steps of real traffic, by default 10% then 50%, each watched for 45
seconds before the next (`"canary": {"steps": [1, 10, 50], "holdSeconds": 60}` in the policy; `false` for none). At
each step every canon fact runs three ways at the same moment with the same inputs: pinned to the new version, pinned
to the old one, and routed as real traffic is. A failure counts against the new version only when the old one passed
the same check at the same moment, and an existing fact that fails on routed traffic while each version passes it
pinned is a mixed-version failure (the two don't work together): twice in a step stops the rollout, once is recorded. Raw requests with no retries go to both versions too, so an error rate the checks'
own retries would hide (a request in eight failing) still shows; and real traffic per version comes from Cloudflare's
analytics when the account allows it. A step that goes wrong takes the new version back out (production's deployment as
it is now, the old version at 100%) and holds the release back; each step and what it saw goes into the acceptance
record. A Durable Object runs one version at a time, so a Durable Object app has no traffic split to stage: its release
candidate (a full copy, with its own long-lived data) is its gate. `canon.json` may name where production answers
(`"production": "https://..."`) when it isn't the deployment's `{project}` address.

In the release gate, a fact that fails at 0% counts against the new version only if the old version answers
differently (both run with the same inputs).

**Canon always equals what production runs.** A canon that isn't released (held back in step 1 or 2, rolled back in
step 4, or a deploy that failed) is reverted: a new canon entry (`reverts` in `deploys`) points back at the last
released canon. Every fact accepted since then is proposed again (a rule a revision retired comes back), and the
accepted claim's verdict says what broke where (`heldBack`); its agent claims the fact again with a fix, because an
attempt held back at release never lands as it is. Claims that forked from the reverted canon carry code production
never ran, so they are behind: the judge re-applies their own change on the restored canon. While a release is in
progress, accepts wait (one release at a time), and a fact held back twice when it went out alone doesn't land automatically
again: the owner decides (a held-back train counts against none of its riders; it splits to narrow the failure down, and a
release that failed without a fact breaking counts separately, four times before the owner decides). A release that
breaks a fact in production is rolled back only when rollback is known to be safe (no stored data touched, or a
rehearsal that passed): otherwise, which only a person's accept can lead to, it stays up, marked broken, and the owner
decides between a fix forward and a rollback with a data repair. The judge checks this invariant on every alarm; `POST /p/:project/reconcile` (owner key) applies it now.

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
the judge, accepts by a person or by policy, the median and p90 time from push to verdict, and compute: minutes from
push to verdict and of timed deliberate-break runs, with `computeUsdEstimate`, every one of those seconds priced as a
busy `standard-4` container at list price (generous per second, but partial: re-applies, trains and releases aren't
timed by the judge).

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
