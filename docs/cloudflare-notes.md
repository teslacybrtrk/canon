# Notes for the Cloudflare team

Canon runs on Workers, Durable Objects, Workflows, Containers, R2, Workers Previews and Artifacts
(binding, Git protocol, event subscriptions). Building it surfaced a few places where the platform could
make agent-scale Git workflows easier. Each note says what we hit, what we did, and what would help.
Found while building, Oct 4–13, 2026.

## Highest impact for agent workflows

1. **Previews of a Durable Object Worker cannot pin an old commit.**
   Inside one Preview, a request to an older deployment's URL runs that deployment's fetch handler, but its
   Durable Objects run the Preview's latest code. A judged attempt therefore stops being reproducible as soon
   as the agent pushes again.
   *We did:* one Preview per pushed commit (`<world>-<sha7>`).
   *Would help:* deployment URLs that pin Durable Object code too, or a documented note on this behaviour.

2. **Forks do not get Previews from Workers Builds.**
   Workers Builds connects one repository, so fork-per-attempt workflows (the pattern the Artifacts docs
   recommend) get no Previews.
   *We did:* our own CI Workflow on `@cloudflare/ci`, triggered by `cf.artifacts.repo.pushed` for the whole
   namespace, running `wrangler preview`.
   *Would help:* Workers Builds for every repo in an Artifacts namespace, or "build forks of this repo".

3. **No public, read-only Artifacts repos.**
   Every clone needs a token, so an open-source project cannot be cloned or browsed from Artifacts alone.
   *We did:* a Worker that proxies Git smart-HTTP (`info/refs`, `git-upload-pack`) with a 5-minute read token
   minted per request and refuses `git-receive-pack`: `git clone https://canon.rodeo/canon.git` works with no
   token, and every world clones the same way. About 40 lines.
   *Would help:* a per-repo public-read flag (clone and browse without a token, never push).

4. **Importing a repo emits no `pushed` event.**
   Pipelines triggered by pushes never see the imported commit.
   *We did:* start the CI Workflow ourselves after `import()`.
   *Would help:* emit `pushed` (or document `repo.imported` as the trigger to use) after an import.

## Developer experience

5. **Previews crash with error 1101 unless the Durable Object binding is repeated under `previews`.**
   Production works with the same config. *Would help:* Wrangler warns, or infers the binding.

6. **No `wrangler preview list`.** Cleaning up Previews needs their names. *We did:* the referee records
   them and exposes `GET /p/:project/previews`. *Would help:* a list command (and `--json`).

7. **Event trigger syntax differs between the docs and the `cloudflare/ci` example**
   (`filter.repoName` + `target.scriptName/workflowName` vs `filter.repo_name` + `targets[{type, workflow_name}]`).
   The example's form deployed. *Would help:* one documented form.

8. **`--json` output is not pure JSON.** `wrangler artifacts repos list --json` prints the login banner on
   stdout first, which breaks piping into `jq`. *Would help:* banner to stderr when `--json` is set.

9. **`@cloudflare/ci` documents its pipeline API but not `CiParams`.** We read the package source to start a
   Workflow with our own parameters (used for promotion and imports). *Would help:* document `CiParams` and
   starting a CI run programmatically. Also note that runner logs are not secret-redacted.

10. **A brand-new Preview can answer 5xx for a moment while its Durable Objects start.**
    *We did:* checks retry only on network errors or unexpected 5xx, never on real failures.

## Things that worked especially well

- `fork()` returns in about a second, and a fork's `source` field records lineage (`artifacts:canon/<parent>`),
  which is effectively a fork tree for free.
- Repo-scoped tokens with revocation made "agents can only write their own world" and "accepted worlds are
  frozen" a few lines each.
- `readFile({ ref: <sha>, path })` from a Worker let the referee read `canon.json` at the exact judged commit.
- Docker Hub images in `containers` meant deploying the CI sandbox needed no local Docker.
- Push to verdict in about 40–50 seconds, including a container install and a Preview deploy.
