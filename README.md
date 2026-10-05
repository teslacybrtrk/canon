# Canon

**Main is not a branch. Main is the set of facts that must stay true of the running app.**

The repo is still Git and the agent still pushes. The only new object is the fact that decides whether that
push becomes main.

Canon is a small protocol on top of [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
for many coding agents sharing one codebase. Agents don't merge branches or open pull requests. Each agent
declares the fact it is trying to make true, works in its own fork (a *world*), and pushes with plain Git. A
referee checks every canon fact against a live Workers Preview of that world. A person accepts a change in
the facts, and the accepted world becomes canon.

- **Coordination**: agents read claims ("agent-4 is trying to make *sold-out items can't be bought* true"), not file locks.
- **Conflicts**: a conflict is a contradiction between worlds. Overlapping edits that keep the facts are fine.
  A clean merge that breaks a fact is not.
- **Review**: the fact diff. Facts kept, facts lost and facts proposed, each linked to a preview and a check.
- **Why**: the fact chain. Every fact links to the world that made it true and to the worlds that failed it.
  Failed worlds are never deleted, so they remain the project's memory.

The facts live in the repo as `canon.json`, so the canon survives outside Cloudflare. A fact works like a
required check in branch protection, but it checks behaviour on a live preview. A person pushing by hand is
just another world and gets the same verdict. You can start from an existing Git repo by importing it.

See [PROTOCOL.md](PROTOCOL.md) for the four moves. To feel the difference in 45 seconds, play
[Canon Rodeo](https://canon.rodeo/game): one round running main the Git way, one the Canon way.

## How it works

```
agent ──canon claim──▶ Referee DO ──fork + token──▶ Artifacts: farmstand-<world>
agent ──git push────────────────────────────────▶ Artifacts ──pushed event──▶ VerifyWorld Workflow
                                                   (container: wrangler preview --name <world>)
VerifyWorld ──judge(world, sha, previewUrl)──▶ Referee DO ──HTTP checks──▶ Workers Preview
human ──accept fact──▶ Referee DO ──freeze world, move canon pointer──▶ PromoteWorld Workflow (wrangler deploy)
```

| Path | What |
|---|---|
| `referee/` | Worker: Referee Durable Object, HTTP API, board, verify/promote Workflows (`@cloudflare/ci`); the site and the game (`public/`) |
| `cli/canon.mjs` | The protocol from a shell: `read`, `claim`, `verdict`, `why` |
| `agents/` | Instructions, goals and claim files for five Claude Code agents, and `run.sh` to start them |
| `demo-app/` | Farmstand, the Workers app the agents change; its facts are in `demo-app/canon.json` |
| `scripts/` | `genesis.sh` (one-time setup), `check-local.ts` (run facts against a local app), `test-ledger.ts` |

## Run it

Requirements: a Workers Paid account with Artifacts (open beta), Node 20+, and Claude Code (`claude`) for the
agents. No Docker: the CI sandbox uses the public `cloudflare/sandbox` image straight from Docker Hub.

1. **Configure the referee**: in `referee/wrangler.jsonc`, set `CLOUDFLARE_ACCOUNT_ID` and replace
   `REPLACE_WITH_SUBDOMAIN` with your workers.dev subdomain.
2. **Create the snapshot bucket and secrets**:
   ```sh
   cd referee && npm install
   npx wrangler r2 bucket create canon-ci-snapshots
   npx wrangler secret put CF_TOKEN              # API token that can deploy Workers
   npx wrangler secret put R2_ACCESS_KEY_ID      # R2 API token for CI snapshots
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   npx wrangler deploy
   ```
3. **Genesis**: push the demo app (with its `canon.json`) as the first world:
   ```sh
   export CANON_URL=https://canon.rodeo   # or https://canon-referee.<subdomain>.workers.dev
   ./scripts/genesis.sh
   ```
   Open `$CANON_URL`. When the genesis preview satisfies every fact in its `canon.json`, it becomes canon.
   To start from an existing repo, set `IMPORT_URL=https://github.com/<you>/<repo>.git`; it needs a `canon.json`.
4. **Start five agents**: `./agents/run.sh`. Claims appear on the board, then verdicts.
5. **Accept a fact** on the board. The world becomes canon and production updates.
   Click a fact to see the world that made it true beside the worlds that failed it.
   After an accept, `./agents/refresh.sh agent-3 agent-4 agent-5` lets worlds that are now behind rebase themselves.
6. **Autopilot** (optional): a second project whose `canon.json` carries a backlog of facts written by people and
   `"autoAccept": "backlog"`. Agents land facts with no human click:
   ```sh
   CANON_PROJECT=rodeo CANON_FILE=agents/canon.autopilot.json ./scripts/genesis.sh
   CANON_PROJECT=rodeo AGENTS=8 ./agents/autopilot.sh      # watch https://canon.rodeo/?p=rodeo
   ```

Work on the demo app locally:

```sh
cd demo-app && npm install && npx wrangler dev
node scripts/check-local.ts http://localhost:8787   # canon.json facts hold; demo claims must not hold yet
node scripts/test-ledger.ts                         # canon.json rules: tampering, revisions, retirement
node scripts/test-scope.ts                          # fact scopes and changed-file detection
node scripts/test-probe.ts                          # retries and latency budgets
node scripts/test-page.mjs                          # board page: unique element ids
```

The referee has no login. Put it behind Cloudflare Access before sharing the URL, because `declare` hands out
write tokens for new forks.

## Notes for Cloudflare

Building Canon surfaced a few places where the platform could make agent-scale Git workflows easier
(for example, Previews that pin Durable Object code per commit, and Workers Builds for forks). They are in
[docs/cloudflare-notes.md](docs/cloudflare-notes.md).

## Where the code lives

The main remote for this repo is a Cloudflare Artifacts repo, and the referee deploys from it with Workers Builds.
Canon serves its own source from Artifacts: browse https://canon.rodeo/src or `git clone https://canon.rodeo/canon.git`
(no token; read-only). Any world clones the same way: `git clone https://canon.rodeo/w/<world-id>.git`.
`scripts/push.sh` pushes to both remotes.
GitHub hosts a mirror as the archive.

## License

MIT
