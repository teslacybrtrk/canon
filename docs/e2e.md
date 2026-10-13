# End to end, on deployed Canon

Run by `scripts/e2e.mjs` on 2026-10-13 18:54 UTC against canon.rodeo, judge at revision `4c84499` (deployed as Worker version `a83d0b92`: `5081b94` plus the first-release fix the previous attempt at this run found), project [`convoy`](https://canon.rodeo/p/convoy/canon) (left up). **This is deployed execution**, not a simulation: the real judge (a Durable Object), Workflows and Containers for every verification and release, Artifacts forks, Workers Previews, the persistent release candidate, merge trains, the release fence, the rollback rehearsal and the gradual rollout on a live Worker. One run; no person clicked.

**Workload.** The stateless Worker from `demo-stateless`, with four backlog facts and policy `{"autoAccept":"backlog","batch":true,"canary":{"steps":[10,50],"holdSeconds":30}}`. Five attempts pushed within seconds of each other:

- agent-1 → “A quote links to its item's page” (`item-link`, declared `--after item-page`)
- agent-2 → “A quote names the item” (`quote-has-name`)
- agent-3 → “A quote names the item” (`quote-has-name-alt`)
- agent-4 → “Each item has its own API page” (`item-page`)
- agent-5 → “Ten or more of an item take 10% off the quote” (`bulk-discount`)

agent-2 and agent-3 build the same fact two ways (a duplicate); agent-1's fact needs agent-4's endpoint; the quote changes edit the same line of the handler.

## Outcome

| Fact | Delivered to production after the first push |
|---|---|
| Ten or more of an item take 10% off the quote | 668 s |
| A quote names the item | 460 s |
| Each item has its own API page | 460 s |
| A quote links to its item's page | 668 s |

Releases: 2 (canon #3: item-link + bulk-discount; canon #2: quote-has-name + item-page). Merge trains landed: 2 (4 facts). Re-applied by the judge: 2. Rejected: 0. Held back: 0. Accepted by a person: 0; by policy: 4.

Verification work: 10 pushes, 10 verdicts, 80 checks; median push to verdict 41 s (p90 50 s).

**Time.** First push to the last fact in production: 660 s (76 s → 736 s in the timeline), including Cloudflare's
queueing, container starts, both releases' release candidates and rehearsals, and the second release's two 30-second
canary holds.

**Cost.** Every Workflow instance of this project, from Cloudflare's own records (`node scripts/timings.mjs --project
convoy`), priced the way the judge prices its compute (each second a fully busy standard-4 container at list price;
instance wall time, so waiting inside an instance counts):

| Workflow | Instances | Seconds | Cost at list price |
|---|---|---|---|
| verify | 12 | 436 | $0.049 |
| mutate (deliberate breaks: diagnostic, not required by this project's policy) | 6 | 464 | $0.052 |
| refresh (re-applies) | 2 | 133 | $0.015 |
| train (merge trains) | 2 | 29 | $0.003 |
| promote (releases) | 2 | 520 | $0.058 |
| **all measured delivery stages** | **24** | **1,582** | **$0.18** |

Not included: the judge's own Worker and Durable Object requests, Artifacts and R2 storage, and the Workers Preview
deploys themselves (billed as Workers requests, not container time). The judge's own `computeUsdEstimate` in
`/stats` ($0.08 here) is a partial figure: it times only push-to-verdict and mutation runs.

Acceptance records: [canon #3](https://canon.rodeo/p/convoy/canon/3/acceptance), [canon #2](https://canon.rodeo/p/convoy/canon/2/acceptance).

- canon #3 (item-link, bulk-discount): authorized by autopilot: merge train convoy-esy9bc, checked and released together; rehearsal passed (the previous version kept all 5 of its facts; nothing to compare, and none needed: the app keeps no stored data (no storage bindings) [0 compared, 0 incompatibl); exposure 10%: no failures, 50%: no failures.
- canon #2 (quote-has-name, item-page): authorized by autopilot: merge train convoy-j3weye, checked and released together; rehearsal passed (the previous version kept all 3 of its facts; nothing to compare, and none needed: the app keeps no stored data (no storage bindings) [0 compared, 0 incompatibl); exposure none recorded.

**Reading it.** Each mechanism shows up in the timeline. The duplicate: both quote attempts were Ready, one rode the first merge
train, and the other was superseded at 240 s without being integrated or released. The prerequisite: agent-1's
attempt was unproven on its own fork (the item pages weren't there yet), was re-applied by the judge onto the canon
that had them, became Ready and rode the second train, with no agent rework. The overlapping change: the discount
edits the same function as the named quote, so it didn't ride the first train; the judge re-applied it on the new
canon and it rode the second. The second train was built and checked while the first was still releasing
(speculative), and landed the moment that release shipped. The first release deployed directly (the project's
production Worker didn't exist yet, so there was nothing to stage beside, and no canary); the second went out at 10%,
then 50%, then 100%. Four facts, two releases, no clicks. Before this run, a first attempt on another fresh project
(`relay`) found that a project's first release couldn't upload a version at all; that was fixed and deployed, and
this run was started from scratch.

## Timeline

```
1s genesis of convoy
46s genesis is canon
68s claimed: agent-1 c-f8801e item-link, agent-2 c-cexxyg quote-has-name, agent-3 c-y0xg2w quote-has-name, agent-4 c-4qgwyy item-page, agent-5 c-hmp6r1 bulk-discount
76s all five pushed
76s agent-5 c-hmp6r1 bulk-discount: open
76s agent-4 c-4qgwyy item-page: open
76s agent-3 c-y0xg2w quote-has-name: checking
76s agent-2 c-cexxyg quote-has-name: checking
76s agent-1 c-f8801e item-link: checking
76s canon #1 []: deployed (healthy)
86s agent-5 c-hmp6r1 bulk-discount: checking
86s agent-4 c-4qgwyy item-page: checking
117s agent-4 c-4qgwyy item-page: ready (it's boarding the next merge train, which leaves in under a minute)
117s agent-1 c-f8801e item-link: unproven
127s agent-5 c-hmp6r1 bulk-discount: ready (it's boarding the next merge train, which leaves in under a minute)
127s agent-3 c-y0xg2w quote-has-name: ready (it's boarding the next merge train, which leaves in under a minute)
127s agent-2 c-cexxyg quote-has-name: ready (it's boarding the next merge train, which leaves in under a minute)
178s train convoy-j3weye: building
209s train convoy-j3weye: judging
240s agent-5 c-hmp6r1 bulk-discount: behind
240s agent-4 c-4qgwyy item-page: accepted
240s agent-3 c-y0xg2w quote-has-name: superseded (it's boarding the next merge train, which leaves in under a minute)
240s agent-2 c-cexxyg quote-has-name: accepted
240s agent-1 c-f8801e item-link: behind
240s canon #2 [quote-has-name, item-page]: pending
240s train convoy-j3weye: landed
250s agent-5 c-fgeqk2 bulk-discount: open
250s agent-1 c-u5ft2v item-link: open
250s agent-5 c-hmp6r1 bulk-discount: superseded
250s agent-1 c-f8801e item-link: superseded
312s agent-5 c-fgeqk2 bulk-discount: checking
333s agent-1 c-u5ft2v item-link: checking
353s agent-5 c-fgeqk2 bulk-discount: ready (it's boarding the next merge train, which leaves in under a minute)
374s agent-1 c-u5ft2v item-link: ready (it's boarding the next merge train, which leaves in under a minute)
374s train convoy-esy9bc: building
395s train convoy-esy9bc: judging
446s train convoy-esy9bc: waiting
528s agent-5 c-fgeqk2 bulk-discount: accepted
528s agent-1 c-u5ft2v item-link: accepted
528s canon #3 [item-link, bulk-discount]: pending
528s canon #2 [quote-has-name, item-page]: deployed
528s train convoy-esy9bc: landed
736s canon #3 [item-link, bulk-discount]: deployed
```

What one run shows and doesn't: it is one arrival order on one small app, with the queue that would compete with it not run on deployed infrastructure (the simulated comparison is [docs/benchmark.md](benchmark.md)). Times include Cloudflare's own queueing, container starts and the canary's 30-second holds.
