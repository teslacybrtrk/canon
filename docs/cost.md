# Cost and scale

What Canon used for the changes it delivered on its five evidence projects, with observed usage, list-price estimates
and bills kept apart. Every figure comes from a record that existed before this note: the judge's run report and
ledger, Cloudflare's Workflow instance records, and the agents' Claude Code transcripts. The only container estimate
is the one [autonomous-run.md](autonomous-run.md) and [e2e.md](e2e.md) already use (`scripts/timings.mjs --project`).
Regenerate the rows with:

```bash
source scripts/env.sh && node scripts/cost.mjs --project final,convoy,rehearse,farmstand,rodeo
node scripts/cost.mjs --logs runs/autopilot/agent-1,runs/agent-4-discount   # agents' tokens, from local transcripts
```

Generated Oct 14, 2026, 03:49 UTC.

## Samples

One run per project, none repeated, so there is no spread to report.

| Project | What ran | When (UTC) | Agents |
|---|---|---|---|
| [final](https://canon.rodeo/ledger?p=final) | autonomous agents on autopilot under a charter ([autonomous-run.md](autonomous-run.md)) | Oct 14 01:29 (Oct 13 Pacific), 22 min | 4 Claude Code: 3 Haiku, 1 Sonnet |
| [farmstand](https://canon.rodeo/ledger?p=farmstand) | autonomous agents; an owner accepting by hand took one change and left six Ready | Oct 12 09:08, 14 min | 12 Claude Code: 9 Haiku, 3 Sonnet |
| [rodeo](https://canon.rodeo/ledger?p=rodeo) | autonomous agents on autopilot, alongside farmstand on the same account | Oct 12 09:11, 14 min | 6 Claude Code: Haiku |
| [convoy](https://canon.rodeo/ledger?p=convoy) | scripted attempts; no model wrote them ([e2e.md](e2e.md)) | Oct 13 18:42, 7 min | 5 names |
| [rehearse](https://canon.rodeo/ledger?p=rehearse) | scripted release-hold tests, in bursts ([live-tests.md](live-tests.md)) | Oct 13 03:56 to 18:08 | 11 names |

farmstand and rodeo ran before the judge had its advisory reviewer, repair model, rollback rehearsals and admission
limits; the other three had them (rehearse's first two hours predate the account-wide limit).

## Per project

| | final | farmstand | rodeo | convoy | rehearse |
|---|---|---|---|---|---|
| **Delivered changes** | **4** | **1** | **2** | **4** | **5** |
| Releases shipped / held back | 4 / 2 | 1 / 0 | 1 / 2 | 2 / 0 | 5 / 4 |
| Pushes registered, each with a verdict | 41 | 25 | 34 | 10 | 24 |
| Fact checks | 697 | 465 | 541 | 80 | 393 |
| **Fact checks per delivered change** | **174** | **465** | **271** | **20** | **79** |
| Fact checks per verdict | 17.0 | 18.6 | 15.9 | 8.0 | 16.4 |
| Re-applied by the judge | 28 | 8 | 8 | 2 | 8 |
| Rejected | 2 | 2 | 1 | 0 | 5 |
| Mutation runs (mutant previews built) | 16 (18) | 14 (≥14) | 12 (≥19) | 4 (5) | 16 (≥15) |
| Merge trains landed (riders) | 1 (2) | 0 | 2 (5) | 2 (4) | 0 |
| Push to verdict, median / p90 s | 45 / 54 | 48 / 77 | 46 / 71 | 41 / 50 | 54 / 75 |
| Verifications building at once, peak (on the account) | 5 (5) | 11 (11) | 7 (11) | 5 (5) | 2 (2) |
| Instance-seconds: verification | 1,998 | 1,375 | 1,711 | 436 | 1,679 |
| re-apply and repair | 351 | 95 | 155 | 133 | 330 |
| deliberate breaks (mutation) | 687 | 670 | 720 | 464 | 807 |
| merge trains | 15 | 0 | 26 | 29 | 0 |
| releases | 1,015 | 96 | 192 | 520 | 1,247 |
| **All instance-seconds (instances)** | **4,067 (100)** | **2,236 (59)** | **2,804 (97)** | **1,582 (24)** | **4,064 (71)** |
| of which inside container steps | 3,789 | 1,982 | 2,374 | 1,071 | 2,629 |
| **List-price estimate, USD** | **0.45** | **0.25** | **0.31** | **0.18** | **0.45** |
| **per delivered change** | **0.11** | **0.25** | **0.16** | **0.04** | **0.09** |

How the rows are counted:

- **Delivered change**: a requested fact released to production and still there (the ledger's "released").
- **Fact check**: one fact judged on one pushed commit (every canon fact, the claimed fact and other facts in flight
  in scope, command facts included), one row in the judge's results table. A re-judge of the same commit replaces its
  rows; checks on release candidates, rehearsals, the 0% gate, canary steps, production and mutants aren't counted.
- **Pushes and verdicts** include the judge's own pushes (re-applies, trains) and the genesis push; see Artifacts below.
- **Push to verdict**: the judge's records, from the push it registered to its first verdict on that commit; n is the
  push count. Cloudflare's records (push event to the end of the judge step) give medians 1 to 4 s higher.
- **Building at once**: from Workflow step times, a verification counts from its install step to its end. Each runs
  one or two containers.
- **Instance-seconds**: wall time of every complete Workflow instance whose repo carries the project's name, from its
  genesis push to its last instance, so background work after the run is in (final: one mutation run, 40 s; farmstand:
  four, 127 s). "Inside container steps" counts side-by-side steps each.
- **≥**: two or three mutation runs' build reports couldn't be read.

**Concurrency observed.** Agents at once: 4 on final, 18 on the account on Oct 12 (farmstand's 12 and rodeo's 6 in the
same quarter hour); convoy's 5 pushes arrived within seconds. The Oct 12 runs had no admission limit and peaked at 11
verifications building at once on the account. The judge now admits 6 per project (since Oct 12, 17:44 UTC) and 12 per
account (since Oct 13, 05:41 UTC); the later runs peaked at 5. The load tests behind those limits (30 and 60 pushes at
once) are in [live-tests.md](live-tests.md).

## Runs on the build/publish split (Oct 13, evening)

The deploy token boundary (PROTOCOL.md, "Push") came in after the runs above. Three runs on it, from the same script:

| | trio2 (autonomous, the submitted judge) | trio (autonomous, first attempt) | split (scripted, as convoy) |
|---|---|---|---|
| Delivered changes / releases held | 2 / 2 | 1 / 2 | 4 / 0 |
| Pushes, fact checks | 10, 111 | 11, 122 | 10, 80 |
| Push to verdict, median / p90 s | 82 / 98 | 71 / 99 | 57 / 76 |
| Workflow instances, instance-seconds | 28, 2,243 | 26, 2,099 | 24, 1,789 |
| **List-price estimate, USD (per delivered change)** | **0.25 (0.13)** | **0.23 (0.23)** | **0.20 (0.05)** |
| Agents, Claude Code's figure | $3.67 (4 sessions, Sonnet) | not recorded separately (sessions stopped) | none |

`split` runs convoy's exact workload: its 16 s higher median is the split's cost per verdict (docs/timings.md).

## Model usage

**Agents.** Tokens are observed, from each transcript's result line. The dollar figure is Claude Code's own (tokens
at Anthropic's API list prices), not an invoice: the agents ran on the operator's Claude plan.

| Run | Transcripts | Uncached input | Cache write | Cache read | Output | Claude Code's figure |
|---|---|---|---|---|---|---|
| final | all 5 sessions: 3 Haiku, 2 Sonnet (one is the discount agent's first start, stopped after 20 s over a name clash) | 1,398 | 247,263 | 10,512,202 | 56,208 | $2.59; $0.65 per delivered change |
| farmstand | 11 of 12 (agent-1's was overwritten) | 1,346 | 239,967 | 7,358,446 | 55,684 | $2.10, incomplete |
| rodeo | 3 of 6 (agents 1 to 3 were overwritten) | 1,302 | 141,979 | 8,212,190 | 57,158 | $1.39, incomplete |

convoy and rehearse used no agent model. At list prices, final's agents came to about six times its Workflow estimate.

**The judge** (Workers AI: `@cf/moonshotai/kimi-k2.7-code`, falling back to `kimi-k2.6`). Calls and outcomes are
observed; tokens aren't recorded, and neither are retries when the model is out of capacity.

| | final | farmstand | rodeo | convoy | rehearse |
|---|---|---|---|---|---|
| Advisory reviews done / unavailable | 10 / 6 | not built yet | not built yet | 5 / 1 | 1 / 3 |
| Reviewer model passes on done reviews | 15 | | | 5 | 1 |
| Re-applies that hit a text conflict | 0 | 2 | 9 | 2 | 6 |
| Sent to the repair model / resolved, then pushed and judged | 0 / 0 | not built yet | not built yet | 2 / 2 | 2 / 2 |
| Seconds waiting on the repair model | 0 | | | 86 | 168 |

## Artifacts operations

| | final | farmstand | rodeo | convoy | rehearse |
|---|---|---|---|---|---|
| Repos created: genesis, attempts, trains, re-applies that didn't push | 41 | 24 | 33 | 10 | 27 |
| Pushes by agents (scripts on convoy and rehearse) | 12 | 16 | 24 | 5 | 15 |
| Pushes by the judge: re-applies / trains / Git notes | 28 / 1 / 6 | 8 / 0 / 1 | 8 / 2 / 3 | 2 / 2 / 2 | 8 / 0 / 9 |

Plus one genesis push each. Repos are the judge's attempts plus the re-applies it deleted after a text conflict (their
forks were made); pushes are the push events Artifacts delivered, each of which starts a verify Workflow. On final that
is about 10 repos and 12 pushes per delivered change. Not counted, because nothing records them: clones, fetches and
pulls (by agents, CI containers and the judge's own file reads), tokens minted, and storage.

## Failed attempts, waste and exclusions

Inside the totals above:

- Everything an attempt cost, whether or not it landed: rejected attempts (2, 2, 1, 0, 5), superseded duplicates, and
  attempts that never passed (final's search took 10 attempts; its stall-hours change took 9 and two held releases).
  That is why checks per delivered change run 2.5 to 25 times checks per verdict.
- Held-back releases (2, 0, 2, 0, 4), with their release candidates, rehearsals and candidate rebuilds.
- Platform retries inside Workflow steps: 5, 0, 0, 2, 11. No verification ended as "could not judge", was dropped as
  stale or was stopped by a newer push. No instance errored or was terminated, so `timings.mjs` (complete instances
  only) left none out.
- The discount agent's stopped first start, in final's agent tokens. Every other session ended normally.

Left out:

- Workflow instances before each project's genesis push. farmstand and rodeo reused the names of earlier test
  projects; starting at the genesis push keeps out 2,393 s of the earlier rodeo's verifications.
- 26 short instances (9 s in all) from those earlier projects' judges, still running after a reset: 3 on farmstand, 23
  on rodeo. `timings.mjs` matches repos by name, so they are in its estimate (under a cent) but not in the counts.
- The load tests and integration runs ([live-tests.md](live-tests.md)), the simulated benchmark
  ([benchmark.md](benchmark.md): local Workers; its repair calls used the deployed repair model through rehearse's
  judge and are reported there as Repairs), other test projects, and the sessions that built Canon.

## Not measured, and why

| Not measured | Why |
|---|---|
| A bill for any run or project | Cloudflare bills the whole account monthly, with included usage, and the account also runs unrelated apps. No invoice line for the agents' model usage was collected. |
| Workers AI tokens or neurons (reviewer, repair) | The judge records calls and outcomes, not their size; account analytics can't separate projects, since one judge Worker serves them all. |
| Artifacts clones, fetches and pulls, tokens minted, storage | Not logged by the judge or anything per project. |
| Workers requests and CPU (judge API and board, agents polling for verdicts, previews, production), Durable Object requests, duration and storage, R2 (CI snapshots), Workers Logs, container egress | No per-project meter; Cloudflare's analytics weren't queried for this note and would show the judge Worker as a whole. |
| Container time as billed | Workflow records give step times, not container run time; container CPU is billed on active use, which isn't exported. |
| farmstand agent-1's and rodeo agents 1 to 3's transcripts | Overwritten when the Oct 13 run reused their directories. |
| People's time; agents' time spent waiting | Not instrumented. |
| Spread between runs | One run per project. |

## Estimates are not bills

- **The Workflow estimate** (`timings.mjs --project`, unchanged) prices each instance-second at $0.0001114: a second
  of a `standard-4` container (4 vCPU, 12 GiB, 20 GB) at list price with every vCPU busy, ignoring what Workers Paid
  includes each month (375 vCPU-minutes, 25 GiB-hours, 200 GB-hours). It overstates container cost: instance time
  includes waiting for a build slot, settle periods and the judge's own checks, and Cloudflare bills container CPU on
  active use, while 72% of the estimate's per-second price is four busy vCPUs. It leaves out everything else: Workflow
  invocations, CPU and steps (2,039 steps in all five projects, against 500,000 included a month), Workers and Durable
  Object requests, Workers AI, Artifacts, R2 and logs.
- **Claude Code's figure** is each transcript's own `total_cost_usd`: tokens at Anthropic's API list prices.
- **Bills.** None can be attributed to a run. One account-level reading, from the billing page on the night of Oct 12
  (Pacific): $1.37 of usage in the cycle so far (container memory $0.74, Workers AI $0.43, R2 $0.20) beyond the $5
  monthly Workers Paid subscription, covering farmstand, rodeo, that day's load tests and everything else on the
  account to then. Artifacts operations and storage weren't billed during any of these runs: Cloudflare starts billing
  them on Oct 14, 2026.
