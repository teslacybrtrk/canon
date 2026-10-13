import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { grantBackground, grantSlot, type SlotState } from "./slots";

/**
 * Account-wide verification capacity. Each project's judge admits at most six verifications at once; this one object
 * admits at most ACCOUNT_SLOTS across every project on the account, so projects share the CI runner instead of
 * competing for it. A free slot goes to the project with the fewest verifications running, then to the one waiting
 * longest (see slots.ts). A slot frees when its project's judge gets the result, or after 15 minutes.
 */
export class Capacity extends DurableObject<Env> {
  private state(): SlotState {
    return (this.ctx.storage.kv.get<SlotState>("state") ?? { slots: {}, waiting: {} }) as SlotState;
  }

  acquire(key: string, project: string, limit: number): "go" | "wait" {
    const state = this.state();
    const { granted, next } = grantSlot(state, key, project, limit, Date.now());
    this.ctx.storage.kv.put("state", next);
    return granted ? "go" : "wait";
  }

  /** Background work: only spare capacity, never ahead of a waiting verification (see grantBackground). */
  acquireBackground(key: string, project: string, limit: number): "go" | "wait" {
    const { granted, next } = grantBackground(this.state(), key, project, limit, Date.now());
    this.ctx.storage.kv.put("state", next);
    return granted ? "go" : "wait";
  }

  release(key: string) {
    const state = this.state();
    delete state.slots[key];
    delete state.waiting[key];
    this.ctx.storage.kv.put("state", state);
  }

  /** What's running and waiting, by project (for the run report). */
  snapshot(): { running: Record<string, number>; waiting: Record<string, number> } {
    const s = this.state();
    const count = (m: Record<string, { project: string }>) => Object.values(m).reduce<Record<string, number>>((t, v) => ((t[v.project] = (t[v.project] ?? 0) + 1), t), {});
    return { running: count(s.slots), waiting: count(s.waiting) };
  }
}
