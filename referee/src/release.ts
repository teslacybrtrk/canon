// The release fence's rule, apart from storage so it can be tested: may a release run take its next step?
// A run holds canon #seq's release as a lease it renews before every step that changes a Worker. Another live holder,
// an expired lease (the run stalled; the judge settles the release without it) or an ended one refuses the step.

export type Lease = { seq: number; sha: string; holder: string; until: number; ended?: string };
export const RELEASE_LEASE_MS = 15 * 60_000;

export function leaseDecision(l: Lease | null, seq: number, holder: string, now: number): { go: true } | { go: false; why: string } {
  if (!l || l.seq !== seq) return { go: true }; // nobody holds this release yet: the first run takes it
  if (l.ended) return l.holder === holder ? { go: false, why: `canon #${seq}'s release was settled: ${l.ended}` } : { go: true };
  if (l.holder !== holder) return l.until > now ? { go: false, why: `another run (${l.holder}) holds canon #${seq}'s release` } : { go: true };
  return l.until > now ? { go: true } : { go: false, why: `this run's hold on canon #${seq} ran out: it stalled, and the judge settles the release without it` };
}

/** Does `holder` hold canon #seq's release right now? (What the judge checks before acting on a run's report.) */
export function holdsLease(l: Lease | null, seq: number, holder: string, now: number): boolean {
  return !!l && l.seq === seq && l.holder === holder && !l.ended && l.until > now;
}
