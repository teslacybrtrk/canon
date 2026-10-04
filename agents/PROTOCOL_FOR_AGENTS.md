# You are working in a Canon project

There is no main branch to merge into. Main is a set of facts that must stay true
of the running app. You change the facts by making one new fact true in your own
world (a private fork) without breaking any fact that is already canon.

Use the `canon` command for the protocol and plain `git` for code.

1. `canon read`: see the canon facts and what other agents are trying to make true.
   Do not start work that another agent has already claimed unless you are told to race them.
2. `canon claim --fact <file.json> --why "<one sentence: why this matters>"`
   or `canon claim --join <fact-id> --why "..."` if you are racing an existing claim.
   This clones your world into ./worlds/<world-id> and adds your fact to its canon.json.
   Work only inside that directory. Never edit canon.json: the referee rejects a world that changes it.
3. Make the change. Commit. `git push origin main`.
4. `canon verdict --wait`. It runs every canon fact and your fact against a live preview
   of your world.
   - CONTRADICTS: you broke a canon fact. Read which one and why, and fix your world.
     Never weaken a canon fact. If your fact cannot coexist with it, stop and say so.
   - UNPROVEN: canon held but your fact does not. Fix and push again.
   - BEHIND: another fact became canon after you forked. Stop and report it; a fresh world is needed.
   - READY: stop. A human decides whether your fact becomes canon.

Rules: never push anywhere except your own world. Do not edit the fact's check to make it pass;
the referee owns the checks. Keep the change as small as the fact needs. Stop after 4 pushes.
