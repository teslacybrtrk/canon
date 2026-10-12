# Notes for the Cloudflare team

Canon runs on Workers, Durable Objects, Workflows, Containers, R2, Workers Previews, Workers versions and Artifacts
(binding, Git protocol, event subscriptions). Building it surfaced a few places where the platform could
make agent-scale Git workflows easier. Each note says what we hit, what we did, and what would help.
Found while building, October 2026.

## Highest impact for agent workflows

1. **Previews of a Durable Object Worker cannot pin an old commit.**
   Inside one Preview, a request to an older deployment's URL runs that deployment's fetch handler, but its
   Durable Objects run the Preview's latest code. A judged attempt therefore stops being reproducible as soon
   as the agent pushes again.
   *We did:* one Preview per pushed commit (`<attempt>-<sha7>`).
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
   token, and every attempt clones the same way. About 40 lines.
   *Would help:* a per-repo public-read flag (clone and browse without a token, never push).

4. **Importing a repo emits no `pushed` event.**
   Pipelines triggered by pushes never see the imported commit.
   *We did:* start the CI Workflow ourselves after `import()`.
   *Would help:* emit `pushed` (or document `repo.imported` as the trigger to use) after an import.

## Developer experience

5. **Previews crash with error 1101 unless the Durable Object binding is repeated under `previews`.**
   Production works with the same config. *Would help:* Wrangler warns, or infers the binding.

6. **No `wrangler preview list`.** Cleaning up Previews needs their names. *We did:* the judge records
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

11. **A CI runner step can fail with `WorkflowInternalError: Attempt failed due to internal workflows error`** after
    several minutes, indistinguishable from a command failure unless you parse the message.
    *We did:* treat only "failed with exit code N" as the command's verdict; retry anything else in a fresh container,
    and report "could not run (platform error)" rather than blaming the code.
    *Would help:* a typed error (`exitCode` on the thrown runner failure) so callers can tell the two apart.

12. **Setting a secret restarts Durable Objects mid-request.** `wrangler secret put` deploys a new version, and an
    in-flight request to the judge's Durable Object failed with "Durable Object reset because its code was updated"
    after it had already created an Artifacts repo, leaving a repo with no record of it.
    *We did:* deleted the orphaned repo and retried.
    *Would help:* secret changes that let in-flight requests finish, or a note in the `secret put` docs that it
    restarts Durable Objects like a deploy.

13. **Previews are capped per Worker and the oldest are deleted without notice** (100 Free, 500 Paid). With a
    Preview per pushed commit, a few busy agent runs reach the cap, and a judged attempt's Preview can disappear.
    *We did:* keep every attempt in Artifacts so its Preview can be rebuilt from the commit, and delete Previews on reset.
    *Would help:* an event or warning before eviction, or a way to pin Previews that matter.

14. **Redeploying a Worker kills its running Containers sessions.** A deploy of the judge's Worker (which also hosts the CI
    sandbox class) ended an in-flight preview build with `SessionTerminatedError: … shell exited (exit code: 1)`
    after seven minutes; the Workflow retried it from scratch.
    *We did:* treat it as a platform error (retry, never blame the code) and avoid deploying while agents push.
    *Would help:* let running container sessions finish on the old version, like in-flight requests.
15. **A push to an Artifacts repo can go by without a `cf.artifacts.repo.pushed` event.** Once in a five-agent run, a
    push landed (the remote's `main` was the new commit) but no Workflow instance started, so the attempt waited
    forever. *We did:* when an agent asks for a verdict, the judge compares the repo's head with the last push it
    heard about (at most once a minute) and starts the pipeline itself for a commit over 90 seconds old.
    *Would help:* at-least-once delivery for push events, or a way to list recent pushes.
16. **Workers can't fetch Preview URLs served on a custom domain** (error 1053, even from another zone), while the
    same deployment answers on `workers.dev` and production custom domains work. *We did:* keep Previews on
    `workers.dev`. *Would help:* custom-domain Previews reachable from Workers, as production custom domains are.

17. **A version override can't reach a Durable Object.** With a new version staged at 0% and
    `Cloudflare-Workers-Version-Overrides` pinning a request to it, the Worker code runs the new version but every
    Durable Object it calls stays on the version its object was assigned (the old one, at 0%). For a Worker whose logic
    lives in its objects, a 0% smoke test answers with old code, or with a new-Worker/old-object mix that fails even
    when the new code is right (it held back two correct releases in an earlier test run, before we understood it). *We did:* for Workers with
    Durable Objects, gate releases on a full release candidate (the commit deployed to its own Worker, with
    production's config and its own long-lived data) and keep the 0% step for Workers without objects. *Would help:*
    an override that also routes the request's Durable Object calls to the staged version, for fresh object ids.
18. **`max_instances` on Containers fails loudly but late.** Eighteen agents plus mutation builds, merge trains and
    releases passed the CI sandbox's `max_instances: 20`; runners then failed with `RPC session was shut down by
    disposing the main stub` and, on the next call, `Maximum number of running container instances exceeded`. *We did:*
    raise it to 40, cap mutation runs at two at a time, and have the judge retry platform errors itself. *Would help:*
    a queueing mode (wait for a free instance) instead of failing the call, and a clearer first error.
19. **`wrangler artifacts repos list` returns one page of 50 with no cursor in its output.** Cleanup scripts silently
    missed repos (including `*-genesis`, so the next setup failed with "repo already exists"). *We did:* list and
    delete in rounds until none are left. *Would help:* `--all`, or a `next` cursor in the JSON.
20. **Version uploads can't carry Durable Object class changes** (they are applied atomically), so a release pipeline
    built on `wrangler versions upload` needs a second path with `wrangler deploy` for those commits. That's
    reasonable, but the upload error should name it plainly so a pipeline can branch on it.
21. **A Durable Object can run the previous version for minutes after a 100% deploy.** After `wrangler deploy`
    reported the new version (and `deployments list` showed it at 100%), a project's object kept answering with the
    old code for about three minutes, including a "does not implement the method" error for an RPC method the new
    version added. The docs do say "seconds to minutes". *We did:* keep RPC changes backward compatible and retry.
    *Would help:* a way to see (or wait for) which version an object is on.
22. **Boards from an old epoch keep their alarms.** We reset a board by changing the name its Durable Object is
    looked up by; the old objects are unreachable by name but their alarms keep firing hourly forever (ours kept
    starting work against repos already deleted). *We did:* on each alarm, an object checks it is still the current
    one for its project and deletes its own alarm if not. *Would help:* listing or deleting a namespace's objects.
23. **Reasoning models on Workers AI can spend the whole budget thinking.** `@cf/moonshotai/kimi-k2.7-code` with a
    4,000-token budget returned an empty answer (`finish_reason: length`); with reasoning off the answers came back but
    were less often right. A 24,000-token budget fixed it. Llama 3.3 70B in JSON mode returned an empty list for the
    same prompt. Kimi also answered "3040: Capacity temporarily exceeded" once. *We did:* retry, then fall back to
    Kimi K2.6.
24. **A brand-new Worker's workers.dev hostname answers 530 for a while.** The first release of a project creates its
    production Worker; for the first minute or so, requests to it got a 530 from Cloudflare's edge, which our judge first
    read as the code breaking a fact (and rolled back a correct release). *We did:* a check answered by the edge (520-530)
    or by nobody never counts against the code; the judge waits for the app instead. *Would help:* `wrangler deploy`
    returning only once the hostname serves, or a distinct, documented status for "not provisioned yet".

## Things that worked especially well

- `fork()` returns in about a second, and a fork's `source` field records lineage (`artifacts:canon/<parent>`),
  which is effectively a fork tree for free.
- Repo-scoped tokens with revocation made "agents can only write their own attempt" and "accepted attempts are
  frozen" a few lines each.
- `readFile({ ref: <sha>, path })` from a Worker let the judge read `canon.json` at the exact judged commit.
- Docker Hub images in `containers` meant deploying the CI sandbox needed no local Docker.
- Push to verdict in about 40–50 seconds, including a container install and a Preview deploy (median 48 s, p90 77 s
  across twelve agents at once).
- The Workers deployments API (`POST /workers/scripts/:name/deployments`) made rolling production back to a named
  version, with an annotation saying why, one request from the judge.
- Workers AI from a Durable Object: a frontier coding model reviewing each Ready change, with structured output, is
  one binding and one call.
- A Workers Preview per mutant: building six deliberately broken versions of a change, each live, in a couple of
  minutes, is what made "test the tests" practical.
