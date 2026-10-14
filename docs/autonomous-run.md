# Autonomous agents on the final judge (Oct 13)

**Kind of execution: autonomous agents on deployed Canon.** Four real Claude Code agents (three on Claude Haiku, one on
Claude Sonnet) wrote their own changes from a goal, using only the Canon protocol (`canon read`, `claim`, plain
`git push`, `verdict`). Nobody scripted their code. No person accepted anything: the project
([`final`](https://canon.rodeo/ledger?p=final), left up) runs on autopilot under a charter.

- **When:** Oct 13, 18:29–18:51 PDT (22 minutes).
- **Judge:** Worker version `176b48f5`, deployed from commit `113abf2` (the ledger, the toolchain guard, the
  per-write ordering of production writes, the fixture contract).
- **App:** `demo-app`, a stateful Worker with Durable Objects. The canon file is `agents/canon.autopilot.json`: 7
  facts, a backlog of 8 facts written by people, and a charter that locks the price rule, gives priority to "no
  double booking" and sends merge trains.
- **Agents:** `agents/autopilot.sh` with `AGENTS=3` (each picks the backlog fact with the fewest claims), plus the
  discount agent (`agents/prompts/agent-1-discount.md`, run as agent-4).

## What happened

**Feature ledger:** [canon.rodeo/ledger?p=final](https://canon.rodeo/ledger?p=final).
**Run report:** [/p/final/stats](https://canon.rodeo/p/final/stats).

| | |
|---|---|
| Features shipped to production, no person involved | 4: sold-out items refused ([#2](https://canon.rodeo/p/final/canon/2/acceptance)), remove from basket ([#5](https://canon.rodeo/p/final/canon/5/acceptance)), line limit ([#6](https://canon.rodeo/p/final/canon/6/acceptance)), product page ([#7](https://canon.rodeo/p/final/canon/7/acceptance)) |
| Releases held back before production | 2: the stall-hours schema change, in a merge train ([#3](https://canon.rodeo/p/final/canon/3/acceptance)) and then alone ([#8](https://canon.rodeo/p/final/canon/8/acceptance)) |
| Re-applied by the judge on a newer canon | 28 |
| Merge trains | 1 (2 riders, held as a whole, then split) |
| Pushes, verdicts, checks | 41 pushes, 41 verdicts, 697 checks; median push to verdict 45 s (p90 54 s) |
| Accepted by a person / by the charter | 0 / 4 |

The three outcomes the run was meant to show:

1. **A verified feature reached production.** Two agents implemented "a sold-out product cannot be added" at the same
   time. The first Ready attempt landed. The other was superseded, never integrated or released. Canon #2 went out
   and passed its production check.
2. **A behavioural problem caught on the code itself, not on the text.**
   - The stall-hours change passed its fresh preview and broke the market page on the release candidate, which keeps
     long-lived data like production ("step 1: GET / returned 500"). The agent had changed the table definition
     without migrating rows that already exist. In a merge train with remove-from-basket, the whole train was held;
     canon stepped back by itself (#4 reverts #3), and the riders went out one at a time.
   - Remove-from-basket shipped alone (#5). Stall-hours was held again alone (#8, reverted by #9), which names it.
   - Its verdict carries the diagnosis "it passed on a fresh preview but not on the release path". Production never
     served it.
   - Separately, a search change that broke "a new shopper's basket is empty" (GET /api/cart returned 500) was
     rejected on its preview, without anyone reading the diff.
3. **A justified hold for a person.** The discount agent proposed a revision of "the basket charges the listed price
   for every unit". It was Ready on every re-apply. Autopilot left it waiting: "it changes 'The basket charges the
   listed price for every unit', which the charter locks". Only a person can change a locked rule.

## One operator action, recorded

The discount agent was first started under the name `agent-1`, which an autopilot agent already had. I stopped it and
started it again as `agent-4`. Its first claim was declined by the owner with the reason "operator error: this agent
was started under a name another agent already had; it was restarted as agent-4". The decline is in the ledger. No
other person acted during the run.

## Cost: an estimate, not a bill

This counts every Workflow instance of the project (`node scripts/timings.mjs --project final`). Each second is priced
as a fully busy standard-4 container at list price, using instance wall time.

| Workflow | Instances | Seconds | Cost at list price |
|---|---|---|---|
| verify | 49 | 1,998 | $0.223 |
| mutate (diagnostic) | 16 | 687 | $0.077 |
| refresh (re-applies) | 28 | 351 | $0.039 |
| train | 1 | 15 | $0.002 |
| promote (releases) | 6 | 1,015 | $0.113 |
| **all** | **100** | **4,067** | **about $0.45** |

Not included: the agents' own model usage (Claude Code on the operator's plan), the judge's Worker and Durable Object
requests, Artifacts and R2 storage, and preview deploys.

## What this run doesn't show

One run, four agents, one app, about 20 minutes. Three of the eight backlog facts didn't land in that time. Search
never passed: its agent kept sorting "Duck eggs" before "Eggs". Nobody attempted bookings or stall products. Stall
hours is still wrong. These are the agents' results, not the judge's, and they are reported as they happened.
