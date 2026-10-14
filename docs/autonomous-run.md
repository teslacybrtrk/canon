# Autonomous agents on deployed Canon

Three runs, newest first. Each says which judge version made its records; a run's records stay as they were recorded.

| Run | When (PDT) | Agents | Judge version (commit) | Records |
|---|---|---|---|---|
| **trio2: on the submitted judge** | Oct 13, 20:27–20:46 | 3 Claude Code (Sonnet), preassigned interacting facts | `00c761d1` (`dcac7ae`) | [ledger](https://canon.rodeo/ledger?p=trio2), [replay](https://canon.rodeo/replay?p=trio2), [run report](https://canon.rodeo/p/trio2/stats) |
| trio: the first attempt at that run, stopped after it surfaced a judge bug | Oct 13, 20:15–20:24 | the same three | `94ad0669` (`568e829`) | [ledger](https://canon.rodeo/ledger?p=trio) |
| final: four agents on a backlog | Oct 13, 18:29–18:51 | 4 Claude Code (3 Haiku, 1 Sonnet) | `176b48f5` (`113abf2`) | [ledger](https://canon.rodeo/ledger?p=final), [run report](https://canon.rodeo/p/final/stats) |

## trio2: the run on the submitted judge

**Kind of execution: autonomous agents on deployed Canon, in a controlled scenario (disclosed).** Three real Claude
Code agents (Claude Sonnet) each got one backlog fact and the Canon protocol, nothing else; every line of code is
theirs. The scenario was set up on purpose: the two discount facts were written so that each holds alone and a naive
combination breaks the bulk-discount fact (the discounts stack), and the third fact needs a change to stored data. No
person accepted anything: the project runs on autopilot under a charter.

- **Judge:** Worker version `00c761d1`, deployed from commit `dcac7ae` (the build/publish split, private-until-published
  projects, the rehearsal fix below). Later commits change only docs, scripts and the ledger's display.
- **App:** `demo-app`, a stateful Worker with a Durable Object. The canon file is
  [`agents/canon.trio.json`](../agents/canon.trio.json): nine facts (the price rule replaced by "a small basket is
  charged the listed price"), and a backlog of three facts written by people. Runner: [`agents/trio.sh`](../agents/trio.sh)
  (the goal text is in it).

What happened (the [replay](https://canon.rodeo/replay?p=trio2) steps through it; times from the judge's records):

1. **A shipped feature.** Agent-1's bulk discount was Ready on its first push and landed by policy two and a half
   minutes in ([canon #2](https://canon.rodeo/p/trio2/canon/2/acceptance)); released as Worker version `1c3b1b28`,
   its rollback rehearsal passed.
2. **A behavioural break despite a clean text merge, fixed by its agent.** Agent-2's order discount ($5 off a basket of
   $50 or more) was judged while the bulk discount landed, so the judge re-applied it on top by itself. The re-apply
   was a clean 3-way apply, no repair (commit `2f376d0`, "Re-apply trio2-u01ahf on canon 2"), and on the combined code
   the bulk-discount fact failed: "totalCents is 5350, expected 5850". The two discounts stacked. Agent-2 read the
   verdict and fixed its own change ("Don't stack the $5 order discount with the per-line bulk discount", commit
   `eda60a4`); the fix held every fact, the judge carried it across two more canon moves, and it landed and was
   released ([canon #5](https://canon.rodeo/p/trio2/canon/5/acceptance), version `f5dee968`, rehearsal passed).
3. **A justified release hold.** Agent-3's stall hours passed its fresh preview and broke the market page on the
   release candidate's long-lived data ("step 1: GET / returned 500"): it redefined the stalls table without migrating
   the rows already there. Held before production ([canon #3](https://canon.rodeo/p/trio2/canon/3/acceptance)); canon
   stepped back (#4); production never served it. The same change was held again later (#6, reverted by #7).

| | |
|---|---|
| Features shipped to production, no person involved | 2: the bulk discount (#2), the order discount after its agent's fix (#5) |
| Releases held back before production | 2: stall hours (#3, #6) |
| Rejected on combined code | 1 (the stacked discounts), counted by the judge's run report |
| Re-applied by the judge on a newer canon | 4 |
| Pushes, verdicts, checks | 10 pushes, 10 verdicts, 111 checks; median push to verdict 82 s (p90 98 s) |
| Accepted by a person / by the charter | 0 / all four acceptances (#2, #3, #5, #6) |

**Interventions, recorded:** one operator action. Agent-3's first session stopped about ten minutes in, believing its
35-minute limit was up, before its hold came back; the operator started it once more with the same goal minus the
time limit (`ONLY=stall-hours ./agents/trio.sh`). That second session claimed the fact again (its reason: "test"),
wrote the same unmigrated change, which was held again, and ended its session meaning to check back later, which a
non-interactive session can't. Nobody accepted, declined or edited anything.

**A setup gap, found afterwards:** trio2's canon file named no production URL, so the judge's hourly production check
went to `trio2.canon.rodeo`, which doesn't exist (HTTP 530). The releases themselves went to the right Worker
(`trio2.canon-rodeo.workers.dev`, which serves them); the judge read the 530s as "the app wasn't reached", marked the
release unverified after ten minutes and rolled nothing back, as designed. The default address is now the Worker's own
workers.dev address (commit `2a35c07`, a configuration change), so later checks reach it.

**What it doesn't show:** one run, three agents, a scenario designed to interact. Stall hours is still unresolved: no
agent wrote the migration after a hold (the Oct 13 run ended the same way). The combined failure's diagnosis says "the
code" rather than "two changes that fail together", because agent-2's first verdict came back "behind" (canon moved
while it was being judged), not Ready; the judge labels a combination only when the earlier verdict was Ready. When
canon moves the judge re-judges a commit in place, so an attempt's earlier Ready verdict isn't kept as its own record
(the claims list still shows each claim's last verdict). Agents misjudged elapsed time; the restart's goal, and the runner
since, have no time limit.

**Cost (estimates, not bills):** 28 Workflow instances, 2,243 instance-seconds, about $0.25 at list price for container
time, $0.13 per delivered change (`node scripts/cost.mjs --project trio2`). The four agent sessions came to $3.67 at
Anthropic's API list prices by Claude Code's own figures (7.8 M cache-read tokens, 33 k output tokens); the agents ran
on a Claude plan. Their sessions lasted 2.8, 9.9, 5.2 and 3.9 minutes.

## trio: the first attempt, and the judge bug it surfaced

The same scenario on judge `94ad0669` (commit `568e829`), 20:15–20:24. Two things happened, both left up in its records:

1. **The combination caught.** The bulk discount landed first (canon #2). The judge re-applied agent-2's order discount
   on top, and on the combined code the bulk-discount fact failed ("totalCents is 5350, expected 5850": the discounts
   stacked).
2. **A correct release held by a judge bug.** Canon #2's rollback rehearsal passed, then its record said "unavailable"
   and autopilot held the release. The cause: a deploy at 20:13 reached the project's judge mid-call, so Workflows ran
   the "check rollback rehearsal" step again; the first run had passed and deleted its fixtures, so the second found
   nothing to compare. The hold was safe (production never served the release) but wrong. The record shows both: its
   `recovery.how` keeps the passed result, its `recovery.rehearsal` the unavailable one.

Fixed in `dcac7ae`: a rehearsal's first verdict stands when the step runs again
([`scripts/test-judge-rehearsal.ts`](../scripts/test-judge-rehearsal.ts) reproduces the retry and fails on the old code).
The run was stopped (agent-1 had already stopped, its fact canon before the hold), and repeated on the fixed judge as
trio2. Its goal also changed in one place: an agent's fact is done when it is released, not when it is canon.

## final: four agents on a backlog (Oct 13)

**Kind of execution: autonomous agents on deployed Canon.** Four real Claude Code agents (three on Claude Haiku, one on
Claude Sonnet) wrote their own changes from a goal, using only the Canon protocol. No person accepted anything: the
project ([`final`](https://canon.rodeo/ledger?p=final), left up) runs on autopilot under a charter.

- **When:** Oct 13, 18:29–18:51 PDT (22 minutes). **Judge:** Worker version `176b48f5`, deployed from commit `113abf2`
  (a historical version now: the build/publish split and the rehearsal fix came later).
- **App:** `demo-app`; canon file `agents/canon.autopilot.json` (7 facts, a backlog of 8 facts written by people, a
  charter that locks the price rule, gives priority to "no double booking" and sends merge trains). Agents:
  `agents/autopilot.sh` with `AGENTS=3`, plus the discount agent (`agents/prompts/agent-1-discount.md`, run as agent-4).

| | |
|---|---|
| Features shipped to production, no person involved | 4: sold-out items refused ([#2](https://canon.rodeo/p/final/canon/2/acceptance)), remove from basket ([#5](https://canon.rodeo/p/final/canon/5/acceptance)), line limit ([#6](https://canon.rodeo/p/final/canon/6/acceptance)), product page ([#7](https://canon.rodeo/p/final/canon/7/acceptance)) |
| Releases held back before production | 2: the stall-hours schema change, in a merge train ([#3](https://canon.rodeo/p/final/canon/3/acceptance)) and then alone ([#8](https://canon.rodeo/p/final/canon/8/acceptance)) |
| Re-applied by the judge on a newer canon | 28 |
| Merge trains | 1 (2 riders, held as a whole, then split) |
| Pushes, verdicts, checks | 41 pushes, 41 verdicts, 697 checks; median push to verdict 45 s (p90 54 s) |
| Accepted by a person / by the charter | 0 / 4 |

1. **A verified feature reached production.** Two agents implemented "a sold-out product cannot be added" at the same
   time; the first Ready attempt landed, the other was superseded, never integrated or released.
2. **A behavioural problem caught on the code itself.** The stall-hours change passed its fresh preview and broke the
   market page on the release candidate's long-lived data ("GET / returned 500"); held in a merge train, then alone;
   production never served it. A search change that broke "a new shopper's basket is empty" was rejected on its
   preview, without anyone reading the diff.
3. **A justified hold for a person.** The discount agent proposed a revision of the locked price rule; autopilot left
   it waiting, since only a person changes a locked rule.

**One operator action, recorded:** the discount agent was first started under a name another agent had; it was stopped,
its first claim declined by the owner with that reason, and restarted as agent-4.

**Cost (an estimate, not a bill):** 100 Workflow instances, 4,067 instance-seconds, about $0.45 at list price for
container time (`node scripts/timings.mjs --project final`); the agents' own model use and everything else on
[docs/cost.md](cost.md). Three of the eight backlog facts didn't land in the time; those are the agents' results,
reported as they happened.
