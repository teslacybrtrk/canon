// The account-wide slot rule, apart from storage so it can be tested: fair between projects, never over the limit.
export type SlotState = {
  slots: Record<string, { project: string; at: number }>;
  waiting: Record<string, { project: string; since: number; seen: number }>;
};
export const ACCOUNT_SLOTS = 12;

export function grantSlot(state: SlotState, key: string, project: string, limit: number, now: number): { granted: boolean; next: SlotState } {
  const slots = { ...state.slots };
  const waiting = { ...state.waiting };
  for (const [k, v] of Object.entries(slots)) if (now - v.at > 15 * 60_000) delete slots[k]; // its project never released it
  for (const [k, w] of Object.entries(waiting)) if (now - w.seen > 60_000) delete waiting[k]; // stopped asking
  if (slots[key]) return { granted: true, next: { slots, waiting } };
  waiting[key] = { project, since: waiting[key]?.since ?? now, seen: now };
  const running = (p: string) => Object.values(slots).filter((s) => s.project === p).length;
  // Fewest running for its project first, then the longest wait: one busy project can't starve the others.
  const next = Object.entries(waiting).sort(([, a], [, b]) => running(a.project) - running(b.project) || a.since - b.since)[0]?.[0];
  if (Object.keys(slots).length >= limit || next !== key) return { granted: false, next: { slots, waiting } };
  delete waiting[key];
  slots[key] = { project, at: now };
  return { granted: true, next: { slots, waiting } };
}
