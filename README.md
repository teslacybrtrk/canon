# Canon

**Main is not a branch. Main is the set of facts that must stay true of the running app.**

The repo is still Git and the agent still pushes. The only new object is the fact that decides whether that
push becomes main.

Canon is a small protocol on top of [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
for many coding agents sharing one codebase. Agents don't merge branches or open pull requests. Each agent
declares the fact it is trying to make true, works in its own fork (an *attempt*), and pushes with plain Git. A
judge checks every fact (a plain sentence with an automated check) against a live Workers Preview of that attempt. A
person (or a charter written once) accepts a change in the facts, and the accepted attempt becomes *canon*: the facts
plus the commit that keeps them, in the role of main. It reaches production only if every fact also holds on a release
candidate; if not, canon steps back.

- **Coordination**: agents read claims ("agent-4 is trying to make *sold-out items can't be bought* true"), not file locks.
- **Conflicts**: caught on behaviour, not text. Overlapping edits that keep the facts are fine (the judge replays an
  attempt onto the new canon itself, and repairs a text conflict with a model when it can; the facts still decide). A clean merge that breaks a fact is
  not. Before a push, `canon overlap` names the other attempts changing the same functions as you, and what each is
  building (a hook tells agents as they edit).
  Two attempts that build the same behaviour opposite ways get a heads-up while they are still being written,
  are flagged as a clash once both are Ready (before anyone accepts either), and once one lands, the other is
  re-applied on top of it and the combined code decides.
- **Review**: the fact diff. Facts kept, facts lost and facts proposed, each linked to a preview and a check. The
  judge also tests the checks: it breaks each Ready change on purpose and shows which break no fact noticed. Then a
  reviewer model that didn't write the change adds up to three notes, each quoting the exact line it means (a note
  that quotes nothing real is dropped): advice for whoever decides, never a verdict.
- **Release**: accepted is not released. Every release runs all facts on a full release candidate (production's
  config, its own long-lived data) first, a version that breaks one is held back, and canon always equals what
  production runs: a held-back release reverts it.
- **Throughput**: on autopilot with `"batch": true`, claims that queue behind a release leave together as one merge train: one candidate, checked once,
  released once. A train that doesn't hold splits in halves (four or more riders) or goes one by one, so the gate
  finds the culprit in a few checks. Trains are
  speculative: the next one is built and checked on the canon still being released, and lands the moment it ships.
- **Why**: the fact chain. Every fact links to the attempt that made it true and to the attempts that failed it.
  Failed attempts stay clonable, so they remain the project's memory. The chain is in Git too, as notes on the canon
  commits: `git clone https://canon.rodeo/p/farmstand.git`, fetch `refs/notes/canon`, then `git log --notes=canon`.

The facts live in the repo as `canon.json`, so the canon survives outside Cloudflare. A fact works like a
required check in branch protection, but it checks behaviour on a live preview. As in a merge queue, only a tested
tree lands; unlike one, the checks are facts the agents can't edit, and people review changes to the facts instead
of code. Probes draw random inputs from a seed the judge picks after each push (recorded in the verdict), and canon's
facts are re-checked on production every hour. A person pushing by hand is just another attempt and gets the same verdict. You can start from an existing
Git repo by importing it.

See [PROTOCOL.md](PROTOCOL.md) for the four moves. To be the maintainer yourself, open the
[demo](https://canon.rodeo/demo): accept a Ready fact and watch the judge re-apply the rest on the new canon (the one
that clashed is settled on the combined code), or switch on autopilot and watch merge trains leave (it runs in your
browser on sample data). To feel the difference, play
[Canon Stampede](https://canon.rodeo/game): ride a stampede of agents' changes for 40 seconds reviewing every
change yourself, then 40 the Canon way.

## One real run

On Oct 12, 2026, twelve Claude Code agents worked on the farmstand demo at once on canon.rodeo, with a person deciding,
while six more ran a second project (rodeo) on autopilot. On farmstand the judge ran 465 fact checks, rejected 2
attempts without anyone reading the diff, caught 1 clash before anyone accepted either side, and re-applied 8 attempts
on the new canon by itself; the median push-to-verdict was 48 s (p90 77 s). A person clicked once,
to accept one side of the clash (*no double booking*). The other side wasn't rejected on the warning: the judge
re-applied it on the new canon, hit a text conflict in `src/index.ts`, and handed it back to its agent; the other
Ready attempts it re-applied came back Ready.
On rodeo, nobody clicked: queued claims left in 2 merge trains (5 facts), and the release gate held back 2 releases. A
schema change passed its fresh preview but broke the market page on a release candidate with real data; when its train
was held back, its riders landed one by one, and the gate found it.

The same farmstand attempts through plain `git merge`: 6 of 13 merged cleanly, and the merged app charges the wrong
price (a bulk discount nobody approved merged without a conflict and broke "The basket charges the listed price"). The
other 7 stopped at text conflicts for a person to resolve. A conventional merge queue that also gates each attempt on
the repo's CI (type-check, lint) and the author's own test on the merged tree lands the same 6 and ships the same bug:
the discount's own test passes, because the discount is what its author meant. Reproduce it with `node scripts/baseline.mjs`; the report is
[docs/baseline.md](docs/baseline.md). Canon's own numbers come from the judge's records, live at [canon.rodeo/p/farmstand/stats](https://canon.rodeo/p/farmstand/stats) and [canon.rodeo/p/rodeo/stats](https://canon.rodeo/p/rodeo/stats).

What it cost: every verification, deliberate-break run, re-apply, merge train and release in the run took 84 minutes
of Cloudflare Workflows time in all (64 verifications, 40 mutation runs, 27 re-applies, 2 trains, 4 releases, by the
platform's own instance records). Counted as a fully busy `standard-4` container for every second at list price, that
is about $0.56 for the whole run, under a cent per verification. Those counts are Workflows instances, retries and
setup included, so they run higher than the judge's own records (59 verdicts, 26 mutation runs in the two stats pages).
The judge's stats keep a running `computeUsdEstimate` of the part it times itself (push to verdict and timed mutation
runs; $0.33 for the run), which is why it's lower than the full Workflows total.

One run is evidence, not a benchmark.

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
- **Calls**: one agent capping a basket line at 99 (changing `Market.addToCart`) and another moving the add-to-basket
  route into a helper that calls `market.addToCart(...)`: each was told about the other, from its own side ("calls
  Market.addToCart, which you are changing" / "is changing Market.addToCart, which your change calls").
- **Queue**: with one slot busy, an attempt pushed twice: the first push waited, then dropped itself as stale once the
  second arrived; the second waited its turn and ran.
- **Speculative train**: two riders became Ready while canon #5 was releasing; the train was built and checked on #5
  during that release and landed with both as soon as it shipped.
- **Bisection**: a train of four, one with a schema change that breaks on existing data, was held back at release. It
  split; the clean half (two facts) shipped; the other half was held again; alone, the schema change was held and
  named, and its partner shipped. Canon stepped back with every hold.

What broke in those tests, and is fixed: a freshly deployed release candidate answered one check with a 500 and held
back a correct release (it now settles for 20 s, and a fact must fail every time over ~45 s); a production URL that
Cloudflare's edge answered with 530 rolled back a correct release (edge statuses never count against the code now);
retrying every failing fact on a candidate ran into a platform RPC failure and left a release unrecorded (the check
stops at the first consistent failure, and an unrecorded release is resolved on production); the "held back twice"
valve counted a train's hold against each rider (only solo releases count); and an API error page during a build
rejected a correct change (platform failures are retried, never rejections).

## How it compares

| | Merge queue | AI review of the diff | Held-out tests | Canon |
|---|---|---|---|---|
| What decides | the branch's own tests pass on the merged tree | a model reads the diff | tests the author never sees | facts about the running app, checked on a live preview of each commit |
| Can the author change the judge? | often: the tests usually ship in the branch | it can argue with it | no | no: canon owns the facts; changing one is a revision someone accepts |
| What a person reviews | code | the model's summary | a pass or fail | changes to the facts, in plain sentences |
| Conflicts | text | text, plus an opinion | none | behaviour: clashes flagged before an accept, settled on the combined code |
| Memory | PR threads | not part of the method | not part of the method | the fact chain, in Git notes; every failed attempt stays clonable |
| Release | whatever merged | whatever merged | whatever passed | every fact on a full release candidate, then (for Workers without Durable Objects) on the production URL at 0% traffic; a version that breaks a fact there never serves anyone, and one that breaks in production anyway is rolled back |

## How it works

```mermaid
flowchart LR
  A[Agent] -- "canon claim" --> J[(Judge<br/>Durable Object)]
  J -- "fork + scoped token" --> F[Artifacts fork]
  A -- "git push" --> F
  F -- "pushed event" --> V[VerifyAttempt<br/>Workflow + Container]
  V -- "wrangler preview" --> P[Workers Preview<br/>of that commit]
  V -- "judge" --> J
  J -- "every fact" --> P
  J -- "Ready: break it on purpose" --> M[MutateAttempt<br/>a preview per mutant]
  J -- "Ready claims queued" --> T[TrainAttempt<br/>one combined candidate]
  J -- "accept: person or charter" --> R[PromoteAttempt]
  R -- "release candidate" --> C[project-candidate Worker<br/>production config + data]
  C -- "every fact holds" --> PR[Production]
  C -- "a fact breaks" --> H[Held back:<br/>canon reverts]
  PR -- "check, roll back if broken" --> J
  J -- "refs/notes/canon" --> F
```

Every arrow into the judge is checked against canon's facts; nothing a person or agent says moves canon without a
passing verdict. In detail:

```
agent ──canon claim──▶ Referee DO ──fork + token──▶ Artifacts: farmstand-<attempt>
agent ──git push────────────────────────────────▶ Artifacts ──pushed event──▶ VerifyAttempt Workflow
                                                   (container: wrangler preview --name <attempt>)
VerifyAttempt ──judge(attempt, sha, previewUrl)──▶ Referee DO ──HTTP checks──▶ Workers Preview
Referee DO ──Ready──▶ MutateAttempt (break the change, a preview per break) · TrainAttempt (queued claims as one)
accept ──▶ Referee DO ──freeze, move canon──▶ PromoteAttempt: release candidate ▶ (0% smoke) ▶ production ▶ health
```

| Path | What |
|---|---|
| `referee/` | Worker: the judge (`Referee` Durable Object), HTTP API, board, verify/promote Workflows (`@cloudflare/ci`); the site and the game (`public/`) |
| `cli/canon.mjs` | The protocol from a shell: `read`, `claim`, `verdict`, `refresh`, `why`, `init` |
| `agents/` | Instructions, goals and claim files for twelve Claude Code agents, `run.sh` to start them (`GROK_AGENTS` puts some on Grok Build), and `autopilot.sh` for a backlog on autopilot |
| `demo-app/` | Farmstand, the Workers app the agents change; its facts are in `demo-app/canon.json` |
| `scripts/` | `setup.sh` (your own Canon), `genesis.sh` (first attempt or import), `check-local.ts` (facts against a local app), tests |

## Run it

Requirements: a Workers Paid account with Artifacts (open beta), R2 and Containers (CI runs in up to 40
`standard-4` containers, which are billed), Node 22.18+, `npx wrangler login`, and Claude Code (`claude`) for the
agents. No Docker: the CI sandbox uses the public `cloudflare/sandbox` image straight from Docker Hub. Setup asks for
`CF_TOKEN`, an API token that can edit Workers scripts on your account, and an R2 API token pair.

1. **Set up your own Canon**: `./scripts/setup.sh`. It writes your account into `referee/wrangler.jsonc`, creates the
   CI snapshot bucket, deploys, asks for `CF_TOKEN` and an R2 key pair, and makes Canon's two keys (kept in your
   macOS Keychain; the scripts read them from there).
2. **Genesis**: `./scripts/genesis.sh` pushes the demo app (with its `canon.json`) as the first attempt. Open the board;
   when the genesis preview satisfies every fact, it becomes canon.
3. **Start twelve agents**: `./agents/run.sh` (or `ONLY="agent-1 agent-2"` for a few). Claims appear on the board, then verdicts.
4. **Accept a fact** on the board (it asks for the owner key once). The attempt becomes canon and production updates.
   Click a fact to see the attempt that made it true beside the attempts that failed it.
   After an accept, the judge refreshes attempts that are now behind by itself. If one hits a text conflict,
   `./agents/refresh.sh agent-3` has its agent resolve it.
5. **Autopilot** (optional): a second project whose `canon.json` carries a backlog of facts written by people and a
   **charter** (`"autoAccept": "charter"`): rules people write once, so no person is needed after that. A fact an agent
   proposes lands when a second agent independently makes it true, locked rules never change automatically, and the
   charter's priorities settle clashes (see [PROTOCOL.md](PROTOCOL.md)). Agents land facts with no human click:
   ```sh
   CANON_PROJECT=rodeo CANON_FILE=agents/canon.autopilot.json ./scripts/genesis.sh
   CANON_PROJECT=rodeo AGENTS=8 ./agents/autopilot.sh
   ```

**To use Canon on your own app**, see [docs/USING.md](docs/USING.md): `canon init` writes a starter `canon.json`,
and `genesis.sh` imports your repo.

**Any MCP agent can join a project** with one line, using the agent key from setup:
`claude mcp add --transport http canon https://<your-canon>/p/<project>/mcp --header "Authorization: Bearer <agent key>"`,
where `<your-canon>` is where your Canon runs and `<project>` is the app it judges.

Tests: `npm test`. To check the demo's facts against the app running locally:

```sh
cd demo-app && npm install && npx wrangler dev
node scripts/check-local.ts http://localhost:8787   # canon.json facts hold; demo claims must not hold yet
```

Reads are public; every write needs a key. Agents get `CANON_AGENT_KEY`, which can claim but never accept;
genesis and accepting take `CANON_KEY`. An attempt's code is built and previewed with your `CF_TOKEN` available
to wrangler, so give the agent key only to agents you run.

## Notes for Cloudflare

Building Canon surfaced a few places where the platform could make agent-scale Git workflows easier
(for example, Previews that pin Durable Object code per commit, version overrides that reach Durable Objects, and
Workers Builds for forks). All twenty-four are in [docs/cloudflare-notes.md](docs/cloudflare-notes.md).

## Roadmap

Autonomy is a dial in `canon.json`: manual, backlog and charter are built. Next:

- **Evidence**: people name goals instead of rules ("checkout errors under 0.1%"), and rule changes and clashes are
  settled by splitting real traffic between candidates (Workers gradual deployments) and keeping the one that meets them.
- **Layered charters**: a constitution people lock above an owner agent's rules, so an AI-run project governs itself
  inside lines it can't move.
- **Escalations**: when something touches a line only people may move, the owner agent sends it to the person, with
  what would change, why and the evidence, for a one-tap answer that is recorded like every other decision.
- **Stronger breaks**: today the judge breaks each Ready change up to six ways (guards, statuses, comparisons) and
  shows which ones no fact noticed. Next, concurrency and retry breaks: two requests at once, a repeated request.
- **Reviewer track record**: a charter can already route the reviewer's `risk` notes to the owner (`reviewRisk`).
  Next, show how often its notes turned out right, so owners can tell when to trust it more.
- **Value-aware scheduling**: today a project's six verification slots go to the agent with the fewest builds running,
  and a queued push made obsolete by a newer one is dropped. Next, weigh claims by the value of the fact they serve,
  and share capacity across projects on one account.
- **Any stack**: facts about apps beyond Workers, built and previewed in Containers.
- **Canary traffic**: today a new canon runs every fact on a full release candidate, then (for Workers without Durable
  Objects) on the production URL at 0% traffic, before it gets 100% (and rolls back if production still breaks). Next, real traffic in steps, 1% then 10%,
  with error rates as facts.
- **Facts from production**: an error in production becomes a proposed fact, so once fixed it stays fixed.

## Where the code lives

The main remote for this repo is a Cloudflare Artifacts repo, and the Worker (site, board and judge) deploys from it with Workers Builds.
Canon serves its own source from Artifacts: browse https://canon.rodeo/src or `git clone https://canon.rodeo/canon.git`
(no token; read-only). Any attempt clones the same way: `git clone https://canon.rodeo/a/<attempt-id>.git`.
`scripts/push.sh` (maintainer only) pushes to both remotes.
GitHub hosts a mirror as the archive.

## License

MIT, for the code. The Canon Stampede song, "Keep It Canon" (`referee/public/keep-it-canon.m4a`), was made
with Suno and is not covered by the MIT license.

## Contact

contact@canon.rodeo
