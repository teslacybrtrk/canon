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

/** How long an accepted release may take to start its run (take the lease) before it stops counting as the owner. */
export const RELEASE_START_MS = 20 * 60_000;

/**
 * Who owns production's deployment right now, for every path that writes it (reconciliation, rollback, restoring after
 * a stale run): any live lease, a release's or a republish's, whatever its canon row says; or a release accepted but
 * not yet started (its run hasn't taken the lease), for a while. null: nobody does, and the judge may correct it.
 */
export function deploymentOwner(l: Lease | null, pending: { seq: number; at: number } | null, now: number): string | null {
  if (l && !l.ended && l.until > now) return `${/-r[0-9a-z]+$/.test(l.holder) ? "a republish" : "the release"} of canon #${l.seq} (${l.holder})`;
  if (!pending) return null;
  if (l && l.seq === pending.seq) return null; // its run took the lease, and that lease has ended or run out
  return now - pending.at < RELEASE_START_MS ? `canon #${pending.seq}'s release, starting` : null;
}

/** A judge deployment write's own request timeout. */
export const JUDGE_WRITE_MS = 20_000;
/** How long a judge write whose outcome is unknown (timed out, connection lost, judge evicted) may still land. */
export const UNKNOWN_WRITE_QUARANTINE_MS = 120_000;

/**
 * The production-write barrier after a judge deployment write: it lifts when the API answered (the write's outcome is
 * known), and otherwise only after a quarantine, because a request the client gave up on may still land remotely. A
 * timeout is never taken for a cancelled write. Before the request it's armed for the whole window (judge evicted mid-
 * write: the outcome is unknown too).
 */
export function writeBarrier(phase: "sending" | "answered" | "unknown", now: number): number {
  if (phase === "answered") return 0;
  return now + (phase === "sending" ? JUDGE_WRITE_MS : 0) + UNKNOWN_WRITE_QUARANTINE_MS;
}
