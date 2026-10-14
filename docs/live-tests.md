# Load tests and live tests

Moved from the README so it stays short; nothing here was edited beyond the headings. Records link to canon.rodeo.

## Load test: 30 pushes at once

Thirty agents' attempts on a throwaway project each pushed a commit within the same second (autopilot off, so every
push is a pure verification: a container install, a Workers Preview, the command facts, every probe). Same 30 commits,
three judge configurations:

| Verification slots per project | Verdicts | Platform errors | First | Median | p90 | Last |
|---|---|---|---|---|---|---|
| unlimited | 3 in the first 10 minutes | the other 27 hit "RPC session was shut down" or subrequest-depth errors, and the judge's retries failed again | | | | |
| 10 | 30 | 3 (retried) | | 803 s | 879 s | 904 s |
| **6** (the default now) | **30** | **0** | 48 s | 115 s | 215 s | 231 s |
| 6, repeated on a second project | 30 | 0 | 42 s | 134 s | 226 s | 235 s |
| 4 | 30 | 0 | 38 s | 156 s | 298 s | 331 s |
| 8 | 30 | 0 | 48 s | 165 s | 240 s | 257 s |
| 6, with **60** pushes at once | 60 | 0 | 56 s | 340 s | 592 s | 652 s |

With no limit the platform buckles. At 10, a few builds stuck in platform retries hold their slots and the queue backs
up. At 6, every push gets a real verdict in under four minutes, and a repeat on a second project agreed. Fewer slots (4)
waste capacity; more (8) contend and are slower too. At 60 pushes the queue simply runs twice as long: every one still
got a real verdict, the last in under 11 minutes. So the judge admits six verifications per project at a time and
queues the rest in their own Workflows (`admit` in referee.ts).

**Landing under load, not just verifying.** Thirty attempts on autopilot (merge trains on) raced to land eight backlog
facts, all pushed in the same second. The first merge train landed five facts after 9 minutes. The other three facts'
attempts all edited the same request handler as that train, and all eleven hit text conflicts when the judge re-applied
them: with scripted agents that can't resolve conflicts, they stalled. That's what bounded repair is for (see
PROTOCOL.md): with it, the repair model resolved ten of those conflicts, every repaired attempt passed every fact, a
second train landed two more facts, and, after one more fix (a repaired attempt that fell behind again wasn't being
re-applied), the last one landed alone. In all: eight of eight facts, three releases, no wrong rejections, nothing held
back, 14 attempts re-applied by the judge, 9 of them repaired.

Then the same test again on a fresh project, with both fixes in and nobody touching it:

| Run | Facts landed | Time to all landed | Releases | Wrong rejections | Held back | Re-applied by the judge | Repaired (peak) |
|---|---|---|---|---|---|---|---|
| 1 (repair built mid-run) | 8 of 8 | (stalled, then fixed) | 3 | 0 | 0 | 14 | 9 |
| 2 (untouched) | **8 of 8** | **21 min** (3 at 7 min, 5 at 12, 7 at 18, 8 at 20) | 4 (trains of 3, 2, 2, then one alone) | **0** | **0** | 31 | 6 |

Run 2's compute, from Workflows' own records: 143 workflow runs, 161 minutes of work once their time waiting in the
queue is taken out (13,876 s of wall time, 4,230 s of it queued): about 20 container-minutes per landed fact, and at
most $1.07 for the run (every busy second priced as a fully busy `standard-4` at list price), so about 13 cents per
landed fact. Still one project and scripted agents: the next measurement is real agents, more of them.

The same 30 attempts through a conventional merge queue (`node scripts/queue-under-load.mjs`: same changes, same
order; an attempt lands only if it merges cleanly and the repo's CI and its author's own test pass on the merged
tree): **5 of 8 features land**, 11 attempts bounce to a person on text conflicts (stall products, double booking and
basket removal never land), and 14 merges are redundant copies of a feature already in, because a queue doesn't know
two attempts are building the same thing. Canon on that workload: 8 of 8, nobody involved, duplicates superseded.

One thing the load did break: under it, a correct change missed the 400 ms page-speed fact (p95 1.7 s) and was
rejected. Now a speed fact that fails also runs on canon's own preview at that moment; if canon is just as slow, the
verdict is a platform error the judge retries, not a rejection. Not measured yet: hundreds of agents, or several busy
projects sharing one account's container limit.


## Live tests after the run

The features built after the Oct 12 run were each tested live on throwaway projects on canon.rodeo the same day
(deleted afterwards, so the boards above stay as the run left them):

- **Heads-up**: agent-2's unfinished double-booking guard (it refused a second booking with 400 instead of 409) and
  agent-3's shared stalls were flagged to both agents while agent-2 was still unproven; when agent-2 finished, the
  heads-up became a clash.
- **Reviewer**: on a Ready booking change, the reviewer model's notes pointed at the guards no fact covered, each quoting
  its line. Getting there took three tries: Llama 3.3 returned nothing, and Kimi needed room to reason.
- **Overlap, while editing**: a real Claude Code session with the overlap hook (its first, file-level version) edited `src/index.ts` in a farmstand
  attempt and was told, unasked, which other agents in flight were changing the same file and what each was building
  (and wasn't told again on the next edit, since nothing had changed). In a single-file app that lists everyone (from
  the load test below, all 29 others), so overlap now goes down to functions: with four agents on one file, the one
  adding a sold-out guard was told exactly one name, the agent adding a line limit to the same `Market.addToCart`, and
  the two changing `fetch` were folded into one line. A real Claude Code session with the current hook, editing
  `addToCart` there, was told unasked that agent-2 was changing `Market.addToCart` to enforce the 99-unit limit, and
  judged its own edit wouldn't conflict.
- **An agent acting on it**: with agent-1's 99-unit line limit pushed, a real Claude Code session (Sonnet, the hook on)
  was asked only to add a route that puts 150 dozen eggs in the basket via `market.addToCart`. The hook told it
  agent-1 was changing `Market.addToCart` for "a single basket line can't exceed 99 units"; before any push, it worked
  out that the two features are mutually exclusive for one product (one basket line can't hold 150 once the cap lands)
  and said so, instead of quietly splitting the call. That's a semantic conflict raised by the agents themselves,
  before either had a verdict.
- **Calls**: one agent capping a basket line at 99 (changing `Market.addToCart`) and another moving the add-to-basket
  route into a helper that calls `market.addToCart(...)`: each was told about the other, from its own side ("calls
  Market.addToCart, which you are changing" / "is changing Market.addToCart, which your change calls").
- **Queue**: with one slot busy, an attempt pushed twice: the first push waited, then dropped itself as stale once the
  second arrived; the second waited its turn and ran. With one slot busy, an agent-proposed fact queued first and a
  backlog fact people wrote queued 11 seconds later: the backlog fact got the next slot (2 turns waited, against 6).
- **Speculative train**: two riders became Ready while canon #5 was releasing; the train was built and checked on #5
  during that release and landed with both as soon as it shipped.
- **Bisection**: a train of four, one with a schema change that breaks on existing data, was held back at release. It
  split; the clean half (two facts) shipped; the other half was held again; alone, the schema change was held and
  named, and its partner shipped. Canon stepped back with every hold.

- **Required evidence** (Oct 12, evening, on a test project, `evid`, left up so its records can be inspected;
  charter `{"mutation": 0.5, "reviewRisk": true}`): a command fact waited for the owner ("deliberate breaks are only
  judged by probe facts"; before, it waited forever with a misleading message). A product page whose change also
  dropped a table had its review fail with Workers AI out of capacity: unavailable, so it waited for the owner, and
  the judge flagged the `DROP TABLE` as destructive. Accepted by the owner anyway, its
  [acceptance record](https://canon.rodeo/p/evid/canon/2/acceptance) names both exceptions and says a failed release
  won't be rolled back automatically; the release Workflow checked the commit against it before deploying, and the
  Git note on that canon commit carries it. A line limit with every piece of evidence passed landed on autopilot with
  no exceptions ([record](https://canon.rodeo/p/evid/canon/3/acceptance)). A stall-products route that put the URL
  into SQL was flagged by the reviewer (a SQL injection, quoting the line) and waited; re-applied by the judge after
  canon moved, it was flagged again on its own.
- **A race**: a concurrent step (8 bookings of one stall at once, exactly one may win) held on farmstand's production
  booking code, which an agent wrote in the run.
- **Rollback rehearsal** (a second test project, `rehearse`, on autopilot): a stall-booking change (a new table and
  inserts) was rehearsed before production: the previous version kept all 6 of its facts on the data the new code
  wrote, so it shipped marked rollback-safe ([record](https://canon.rodeo/p/rehearse/canon/2/acceptance)). A change
  that moved sold-out goods into their own table (a `DELETE FROM products`, not a schema change, so no pattern would
  flag it) passed every fact, but the rehearsal showed the previous version listing 5 products, not 6, on the migrated
  data: autopilot held it back, production never ran it
  ([record](https://canon.rodeo/p/rehearse/canon/7/acceptance), with the candidate rebuild).
- **Rehearsal with state continuity, and the judge writing production** (`rehearse`, canon #10): the release uploaded a
  version of a Durable Object app and the judge put it at 100% (no `wrangler deploy` from the run); the rehearsal kept
  all 8 previous facts, and compared reads on the state the new code wrote with reads on the state the old code wrote
  ([record](https://canon.rodeo/p/rehearse/canon/10/acceptance)).
- **Held-out facts** (`rehearse`): the owner's "a basket line can never hold a negative quantity" was refused, because
  canon breaks it (an earlier test change allows it); "adding the same product twice adds the quantities up" was
  stored, and agents see it with no check. A change that quietly made a repeated add overwrite instead was rejected,
  its verdict saying only that a held-out fact broke.
- **Prerequisites** (`rehearse`): a product page declared `after` search-by-name; Ready, it waited ("it builds on
  'Shoppers can search products by name', which isn't canon yet"). When search-by-name landed (canon #12, its
  rehearsal now read-only: the old version kept all 11 facts and read back the new version's writes in 6 comparisons),
  the judge re-applied the product page on top, and the combined code failed the linter (the request handler grew too
  complex with both features): the dependency resolved, and the combination judged on its own.
- **Gradual rollout** (a third test project, `canary`, a stateless Worker): a correct change went out at 10%, then 50%,
  then 100%, no failures on either version ([record](https://canon.rodeo/p/canary/canon/2/acceptance)). A change with
  an upstream lookup failing one request in eight passed its preview, its release candidate and the 0% smoke test
  (every check passes on a retry), and an owner accepted it ("item pages are wanted for the shop", kept as the reason);
  at 10% the canary's raw requests failed 4 of 40 on the new version against 0 of 40 on the old, so it was taken back
  out and held, and production never served it to more than a tenth of requests for 45 seconds
  ([record](https://canon.rodeo/p/canary/canon/3/acceptance)). Real traffic per version came from Cloudflare's
  analytics too (68 requests on the new version, 40 on the old), but those count exceptions, not 503s the app returns:
  why the raw requests are there.
- **Specialist review and stronger breaks** (`evid`): a booking change (a new table and inserts) was reviewed in two
  passes, general and data, with its coverage recorded (one file, shown around its changes); the data specialist
  pointed at a `DROP TABLE` that runs every time the object starts. The new breaks (a dropped uniqueness constraint,
  a retry that overwrites, a migration that isn't re-runnable) got past its facts: 2 of 5 caught, under the charter's
  50%, so it waited for the owner.
- **Scope**: a claim that declared `src/index.ts` and also edited `README.md` waited for the owner ("outside the files
  its claim said it would touch"); one that stayed in scope landed, its record saying so
  ([record](https://canon.rodeo/p/rehearse/canon/9/acceptance), which also lists the alternatives it passed over).

- **The fixture contract, live** (Oct 13): on `rehearse`, an agent's stall-products change landed on autopilot as
  canon #13 and was rehearsed: 6 facts compared (the previous version read back, by the ids it saved, what the new
  version wrote, beside what it wrote itself), 1 not applicable (its only write is refused), and 2 unsupported: the
  booking and line-limit facts write state and have no GET step to read it back. Unsupported is missing evidence, not
  a pass, so the rehearsal was unavailable and autopilot held the release; production never served it, and the record
  says which facts need a read step ([record](https://canon.rodeo/p/rehearse/canon/13/acceptance)). On `evid`, the
  owner accepted search-by-name over an unavailable review; its rehearsal was unavailable for the same reason, and it
  went out on the owner's authority with `recovery.override` naming exactly that
  ([record](https://canon.rodeo/p/evid/canon/5/acceptance)).

What broke in those tests, and is fixed: the first end-to-end run on a brand-new project (`relay`, Oct 13) passed
its merge train, release candidate and rehearsal, then couldn't upload its first version, because Cloudflare won't
upload a version of a Worker that doesn't exist yet; the release was held back and canon stepped back, as it should,
and a project's first release now deploys directly (there is nothing in production to stage beside). `relay`, left
on autopilot, had been held back twice on it (canon #2 and #4, each reverted); after the fix it landed all four facts
by itself (canon #6 to #8), with no clicks. Earlier: the first line-limit attempt was flagged by the reviewer (two adds of 50 and
60 make a line of 110) and waited, but its re-apply drew a review without that risk and landed, so a risk named on an
attempt now stands on its re-applies until an agent changes the code (deployed; in the live retest the reviewer named
the risk again itself, so that rule didn't have to act). Two reviews were cut off by a deploy and sat at "reading"
(a stuck review is now retried once, and the wait is re-checked when it would time out; the retry finished and named
the SQL injection). The first held-back data migration left the release candidate's data in a shape production
never had, and the next, correct, release was held back on it (it's in that release's alternatives above); a release
that touched data and didn't ship now rebuilds the candidate from production's code, and the next correct release
shipped. Earlier: a freshly deployed release candidate answered one check with a 500 and held
back a correct release (it now settles for 20 s, and a fact must fail every time over ~45 s); a production URL that
Cloudflare's edge answered with 530 rolled back a correct release (edge statuses never count against the code now);
retrying every failing fact on a candidate ran into a platform RPC failure and left a release unrecorded (the check
stops at the first consistent failure, and an unrecorded release is resolved on production); the "held back twice"
valve counted a train's hold against each rider (only solo releases count); and an API error page during a build
rejected a correct change (platform failures are retried, never rejections).

