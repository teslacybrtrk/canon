# Canon

**Main is not a branch. Main is the set of facts that must stay true of the running app.**

The repo is still Git and the agent still pushes. The only new object is the fact that decides whether that
push becomes main.

Canon is a small protocol on top of [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
for many coding agents sharing one codebase. Agents don't merge branches or open pull requests. Each agent
declares the fact it is trying to make true, works in its own fork (a *attempt*), and pushes with plain Git. A
judge checks every canon fact against a live Workers Preview of that attempt. A person accepts a change in
the facts, and the accepted attempt becomes canon.

- **Coordination**: agents read claims ("agent-4 is trying to make *sold-out items can't be bought* true"), not file locks.
- **Conflicts**: a conflict is a contradiction between attempts. Overlapping edits that keep the facts are fine (the
  agent resolves any text conflict when it refreshes onto canon). A clean merge that breaks a fact is not.
- **Review**: the fact diff. Facts kept, facts lost and facts proposed, each linked to a preview and a check.
- **Why**: the fact chain. Every fact links to the attempt that made it true and to the attempts that failed it.
  Failed attempts stay clonable, so they remain the project's memory.

The facts live in the repo as `canon.json`, so the canon survives outside Cloudflare. A fact works like a
required check in branch protection, but it checks behaviour on a live preview. As in a merge queue, only a tested
tree lands; unlike one, the checks are facts the agents can't edit, and people review changes to the facts instead
of code. Probes draw random inputs seeded by each commit, and canon's facts are re-checked on production every
hour. A person pushing by hand is just another attempt and gets the same verdict. You can start from an existing
Git repo by importing it.

See [PROTOCOL.md](PROTOCOL.md) for the four moves. To feel the difference, play
[Canon Stampede](https://canon.rodeo/game): ride a stampede of agents' changes for 40 seconds reviewing every
change yourself, then 40 the Canon way.

## How it works

```
agent ──canon claim──▶ Referee DO ──fork + token──▶ Artifacts: farmstand-<attempt>
agent ──git push────────────────────────────────▶ Artifacts ──pushed event──▶ VerifyAttempt Workflow
                                                   (container: wrangler preview --name <attempt>)
VerifyAttempt ──judge(attempt, sha, previewUrl)──▶ Referee DO ──HTTP checks──▶ Workers Preview
human ──accept fact──▶ Referee DO ──freeze attempt, move canon pointer──▶ PromoteAttempt Workflow (wrangler deploy)
```

| Path | What |
|---|---|
| `referee/` | Worker: the judge (`Referee` Durable Object), HTTP API, board, verify/promote Workflows (`@cloudflare/ci`); the site and the game (`public/`) |
| `cli/canon.mjs` | The protocol from a shell: `read`, `claim`, `verdict`, `refresh`, `why`, `init` |
| `agents/` | Instructions, goals and claim files for five Claude Code agents, and `run.sh` to start them |
| `demo-app/` | Farmstand, the Workers app the agents change; its facts are in `demo-app/canon.json` |
| `scripts/` | `setup.sh` (your own Canon), `genesis.sh` (first attempt or import), `check-local.ts` (facts against a local app), tests |

## Run it

Requirements: a Workers Paid account with Artifacts (open beta), Node 22.18+, and Claude Code (`claude`) for the
agents. No Docker: the CI sandbox uses the public `cloudflare/sandbox` image straight from Docker Hub.

1. **Set up your own Canon**: `./scripts/setup.sh`. It writes your account into `referee/wrangler.jsonc`, creates the
   CI snapshot bucket, deploys, asks for `CF_TOKEN` and an R2 key pair, and makes Canon's two keys (kept in your
   macOS Keychain; the scripts read them from there).
2. **Genesis**: `./scripts/genesis.sh` pushes the demo app (with its `canon.json`) as the first attempt. Open the board;
   when the genesis preview satisfies every fact, it becomes canon.
3. **Start five agents**: `./agents/run.sh`. Claims appear on the board, then verdicts.
4. **Accept a fact** on the board (it asks for the owner key once). The attempt becomes canon and production updates.
   Click a fact to see the attempt that made it true beside the attempts that failed it.
   After an accept, `./agents/refresh.sh agent-3 agent-4 agent-5` lets attempts that are now behind rebase themselves.
5. **Autopilot** (optional): a second project whose `canon.json` carries a backlog of facts written by people and
   `"autoAccept": "backlog"`. Agents land facts with no human click:
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
(for example, Previews that pin Durable Object code per commit, and Workers Builds for forks). They are in
[docs/cloudflare-notes.md](docs/cloudflare-notes.md).

## Where the code lives

The main remote for this repo is a Cloudflare Artifacts repo, and the Worker (site, board and judge) deploys from it with Workers Builds.
Canon serves its own source from Artifacts: browse https://canon.rodeo/src or `git clone https://canon.rodeo/canon.git`
(no token; read-only). Any attempt clones the same way: `git clone https://canon.rodeo/a/<attempt-id>.git`.
`scripts/push.sh` pushes to both remotes.
GitHub hosts a mirror as the archive.

## License

MIT

## Contact

contact@canon.rodeo
