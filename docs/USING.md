# Use Canon on your own app

Canon works today for an app that deploys as a **Cloudflare Worker** and installs with **npm** from a lockfile
at its repo root. That's what the CI pipeline runs on every push: `npm ci --ignore-scripts`, then
`wrangler preview`. The protocol isn't tied to Workers; this pipeline is. Plan on about 15 minutes.

You need: Workers Paid with Artifacts (open beta), Node 22.18+, `npx wrangler login`, and a coding agent that
can run shell commands (Claude Code, Codex, or anything with a terminal).

## 1. Deploy your referee

From a clone of this repo:

```sh
./scripts/setup.sh
```

It asks for your account ID, your workers.dev subdomain, an optional custom domain and your app's Worker name.
It writes them into `referee/wrangler.jsonc`, creates the CI snapshot bucket and deploys the referee. Then it
asks for three secrets: `CF_TOKEN` (an API token that can edit Workers scripts) and an R2 key pair. Last, it
makes Canon's two keys and keeps them in your macOS Keychain: the owner key accepts facts, the agent key can only
claim them. On Linux, set `CANON_KEY` and `CANON_AGENT_KEY` with `wrangler secret put` and export them instead.

The referee has no accounts or sign-up. Anyone can read the board; writes need a key.

## 2. Write the facts

In your app's repo:

```sh
node /path/to/canon/cli/canon.mjs init
```

This writes a starter `canon.json`:
- **home-page-answers:** the home page answers.
- **code-typechecks:** the code type-checks, with no errors silenced. Only added if the repo has a `tsconfig.json`.
- **tooling-locked:** your lockfile, package.json and wrangler config only change by revision.

Then add the few behaviours that must never break silently: money, permissions, data. Each fact is a plain
sentence plus a check that can fail. All of these must hold on your app today; new behaviour comes later, as
claims.

```json
{ "id": "price-is-listed", "sentence": "The basket charges the listed price for every unit",
  "check": { "kind": "probe", "samples": 4,
    "vars": { "qty": { "int": [1, 20] }, "item": { "oneOf": [ { "id": "eggs", "cents": 400 }, { "id": "kale", "cents": 300 } ] } },
    "steps": [
      { "method": "POST", "path": "/api/cart", "body": { "productId": "{{item.id}}", "qty": "{{qty}}" }, "expect": { "status": 200 } },
      { "path": "/api/cart", "expect": { "json": { "totalCents": "{{qty * item.cents}}" } } }
] } }
```

Each check is one of two kinds:
- **Probe:** HTTP requests against a live preview of each commit. `vars` draws random inputs from the commit's
  own hash, so an agent can't hard-code the answers, and the same commit always gets the same inputs.
- **Command:** a shell command run on each commit's checkout in CI, such as a linter, a type-check or a test
  suite. Call tools directly, not package scripts, so a world can't redefine what judges it.

A `scope` list of file globs judges a fact only on worlds that change a matching file. The full format is in
[PROTOCOL.md](../PROTOCOL.md).

### Keep check runs apart, and keep previews off your data

Every probe run sends a fresh `x-canon-run` header. For facts that write state, give each run its own state:

```ts
const run = request.headers.get("x-canon-run") ?? "public";
const store = env.STORE.get(env.STORE.idFromName(run)); // a Durable Object per check run
```

Facts that only read can skip this with `"isolate": false`. Their requests are then sent exactly as a visitor's
would be, so the app can't tell it's being checked.

Each Preview gets its own Durable Objects automatically. Repeat the binding under `previews` in your wrangler
config, as [demo-app/wrangler.jsonc](../demo-app/wrangler.jsonc) does. **KV, D1 and R2 bindings are not isolated
automatically.** Give previews their own resources under `previews`, or every agent's preview will read and write
your production data.

### Check locally before you start

Run your app with `npx wrangler dev`, then:

```sh
node /path/to/canon/scripts/check-local.ts http://localhost:8787 canon.json
```

Every fact must print `HOLDS`. Commit `canon.json`.

## 3. Import your repo

```sh
CANON_PROJECT=myapp IMPORT_URL=https://github.com/<you>/<repo>.git ./scripts/genesis.sh
```

The import must be a Git URL that Artifacts can clone; public repos work. Open your board at
`<referee>/?p=myapp`. The import becomes canon, the project's "main", once its preview satisfies every fact.

## 4. Point your agents at it

The quickest way is MCP. Every project has an MCP endpoint, and any MCP agent (Claude Code, Cursor, Codex)
connects with one line and the agent key:

```sh
claude mcp add --transport http canon <referee>/p/myapp/mcp --header "Authorization: Bearer <the agent key>"
```

The agent then has `canon_read`, `canon_claim`, `canon_verdict`, `canon_refresh` and `canon_why`, and needs nothing
else to know the protocol. Claiming returns the commands that clone its world and record the claim; it still pushes
with plain Git.

Or use the CLI: put `cli/canon.mjs` on the agent's PATH as `canon`, set its environment, and give it
[agents/PROTOCOL_FOR_AGENTS.md](../agents/PROTOCOL_FOR_AGENTS.md) plus a goal:

```sh
export CANON_URL=<referee> CANON_PROJECT=myapp CANON_AGENT=agent-1 CANON_KEY=<the agent key>
claude -p "$(cat /path/to/canon/agents/PROTOCOL_FOR_AGENTS.md) Goal: make search case-insensitive."
```

The agent reads canon, claims the fact it will make true, works in its own fork, pushes with plain Git, and
reads the verdict. [agents/run.sh](../agents/run.sh) starts several at once, each with its own goal.

## 5. Review facts, not diffs

READY cards on the board keep every canon fact and make their own fact true. Accepting one asks for the owner key
once. It deploys that world to production, as a Worker named after the project at
`https://myapp.<subdomain>.workers.dev`. Your existing production Worker is untouched until you point your domain
at that one.

- **When canon moves,** worlds built before it are *behind*: `canon refresh` replays them onto the new canon.
- **To change a rule on purpose,** an agent proposes a revision: a fact with `"replaces": "<id>"`. A person decides.
- **For no human in the loop,** add `"backlog"` facts and `"policy": { "autoAccept": "backlog" }` to
  `canon.json`. A world that makes a backlog fact true lands on its own. Facts agents invent still wait for a person.

## Limits today

- **Apps:** only Workers apps built with npm, from the repo root. A world's own build runs in CI with your
  `CF_TOKEN` available to wrangler, so give the agent key only to agents you run.
- **Pace:** one canon move at a time. Each accept sends the worlds in flight to refresh; batching, as in merge
  queues, is the next step.
- **Previews:** Workers keep the newest 500 per Worker. Older worlds stay clonable from Artifacts.
