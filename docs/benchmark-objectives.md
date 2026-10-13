# Benchmark objectives (written before the final run)

Author-defined, committed before the final benchmark run so the results can be read against them rather than the
other way round. Nobody outside the project agreed to them; that's listed under what isn't done.

## What is compared

- **Strong merge queue**: every protected check on the merged tree, then ship.
- **Merge queue with the same release safeguards**: the same, plus a release candidate on long-lived data, a rollback
  rehearsal, a canary and a gate on destructive data changes. These are not Canon's alone.
- **Canon**: the safeguards plus its coordination (supersede a claim whose fact is already canon; hold a claim until
  the facts it declares it builds on are canon).

All get the same checks, the same repair service, the same agent behaviour (an attempt whose own fact fails is
resubmitted once, at the back) and the same machine.

## Objectives and tolerances

1. **Safety is a constraint, not a score.** Canon: 0 wrong accepts, 0 unrecoverable incidents and 0 releases unsafe to
   roll back, in every run of every workload. Against the safeguarded queue, safety parity is the expected result and
   is reported as parity, never as an advantage. Against the plain queue, safety differences are attributed to the
   release safeguards.
2. **Delivery is not traded for efficiency.** In every order of every workload, Canon delivers at least as many
   features safely as the safeguarded queue (tolerance: 0).
3. **Coordination saves work where it applies.** On the coordination workload, Canon's median across runs is lower than
   the safeguarded queue's in checks (by at least 10%), releases and repair calls, with the same features delivered.
   If not, that's reported as no advantage.
4. **No material regression elsewhere.** On the data, stateless and integration workloads, Canon's checks are at most
   1.25 times the safeguarded queue's (median across runs).
5. **Time is claimed only from controlled runs.** Elapsed time from runs that shared the machine is reported as
   "under contention" and not compared. A speed difference is claimed only from the sequential (one process at a time)
   coordination run, and only if Canon's slowest run is faster than the queue's fastest; otherwise "no reliable
   difference".

## Metric definitions

- **Safely landed**: in production at the end, every fact holding, and the release can be rolled back safely.
- **Wrong accepts**: releases that broke a fact in production (including a lost shopper's basket, or a users' error
  rate above 5% on the stateless app).
- **Unrecoverable**: a wrong accept a rollback didn't repair (data lost).
- **Unsafe to roll back**: shipped releases whose previous version, run on production's data afterwards, broke a fact.
- **Rejections**: attempts sent back (CI failed, a fact broke on the merged tree, held at release). **Resubmissions**:
  of those, the ones whose own fact failed, which the modelled agent sends once more. These count events, not agent
  effort: no agent's time is measured.
- **Repairs**: calls to the repair model; **repair failures**: calls that returned no usable file.
- **Redundant**: attempts that delivered nothing new (a duplicate of a feature already in), and the checks and
  releases spent on them.
- **Checks**: every fact check and command run, on any system, including a duplicate's own verification in Canon.
- **Releases**: deployments to the modelled production.
- **Orders vs repeats**: an order is one arrival sequence (order 1 as written, the others seeded shuffles, the same for
  every system); a repeat is the same order run again, which differs only through timing and the repair model.

## Not done before the deadline

- Workloads written by someone other than Canon's author, and a study with outside maintainers.
- Objectives agreed with anyone outside the project.
- Merge trains modelled for both systems in the simulation (the deployed run, docs/e2e.md, has real trains for Canon
  only).
- A queue baseline on deployed infrastructure.
