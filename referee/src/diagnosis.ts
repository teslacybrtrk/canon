// What kind of failure a verdict is, and what would resolve it: the code, the requirement, a check that can't be made,
// the platform, or two changes that only fail together. A guide for whoever acts next (the agent, or the owner for a
// requirement), never a verdict: the facts still decide, and only a person changes a protected requirement.
import type { Verdict } from "./protocol";

export type DiagnosisKind = "implementation" | "requirement" | "unsupported-check" | "infrastructure" | "combination";
export interface Diagnosis {
  kind: DiagnosisKind;
  why: string;
  next: string;
}

export interface DiagnosisContext {
  reapplied: boolean; // the judge re-applied this attempt's change onto a newer canon
  passedBefore: boolean; // the attempt it re-applies was Ready on its own base
  sameFailureElsewhere: number; // other attempts at the same fact that fail it with the same assertion
}

/** An assertion without the inputs drawn for it, so failures with different random inputs compare equal. */
export function assertionOf(detail: string): string {
  return detail.replace(/\s*\(with [^)]*\)\s*$/, "").replace(/^sample \d+, /, "").trim();
}

export function diagnose(v: Pick<Verdict, "outcome" | "lost" | "stale" | "claimed" | "heldBack">, ctx: DiagnosisContext): Diagnosis | null {
  if (v.outcome === "ready" || v.outcome === "pending") return null;
  if (v.outcome === "error") {
    return { kind: "infrastructure", why: "the platform failed (a container, an RPC or a Workflow), not the code", next: "nothing to fix: the judge retries it; push again if it keeps happening" };
  }
  if (v.heldBack) {
    if (/couldn't be compared|unsupported|inconclusive|couldn't be deployed/.test(v.heldBack)) {
      return { kind: "unsupported-check", why: `the release couldn't establish that its rollback is safe: ${v.heldBack.slice(0, 200)}`, next: "the owner adds the missing evidence (a GET step that reads back what a fact writes, or \"fixture\": \"none\" on a fact that leaves nothing to read), or accepts it as an exception, which the record names" };
    }
    if (/release candidate|rollback rehearsal|production traffic|smoke test/.test(v.heldBack)) {
      return { kind: "implementation", why: `it passed on a fresh preview but not on the release path: ${v.heldBack.slice(0, 200)}`, next: "fix the code for existing data and real traffic (a migration for rows that already exist, a backward-compatible format), then claim the fact again" };
    }
  }
  if (v.outcome === "contradicts") {
    const lost = v.lost[0];
    if (ctx.reapplied && ctx.passedBefore) {
      return { kind: "combination", why: `it held on its own base, and breaks “${lost?.factId}” only combined with what became canon since (${lost?.detail.slice(0, 140) ?? ""})`, next: "change it on top of the current canon so both hold; if the two rules can't both hold, the owner picks one (a revision)" };
    }
    return { kind: "implementation", why: `it breaks a canon fact, “${lost?.factId}”: ${lost?.detail.slice(0, 160) ?? ""}`, next: "fix the code so that fact holds again (the fact's check is in the verdict); if the fact itself should change, propose a revision for a person to accept" };
  }
  if (v.outcome === "behind") {
    return { kind: "combination", why: `canon moved after it forked, and a newer fact fails on it (${v.stale[0]?.factId ?? "a newer fact"})`, next: "nothing yet: the judge re-applies it on the current canon and judges the combined code" };
  }
  // unproven: its own fact doesn't hold.
  if (/already passes on the commit this attempt forked from/.test(v.claimed.detail)) {
    return { kind: "requirement", why: "its fact already holds before the change, so the fact doesn't capture what the change does", next: "the fact's author tightens it (a check that fails without the change); only a person changes a protected fact" };
  }
  if (/toolchain protected/.test(v.claimed.detail)) {
    return { kind: "implementation", why: v.claimed.detail.replace(/^build failed: /, "").slice(0, 220), next: "undo the dependency or build-command change and push; the owner changes the toolchain (it runs with deploy credentials)" };
  }
  if (/^build failed/.test(v.claimed.detail)) {
    return { kind: "implementation", why: `the code didn't build or deploy as a preview: ${v.claimed.detail.slice(13, 180)}`, next: "fix the build, then push" };
  }
  if (ctx.sameFailureElsewhere >= 2) {
    return { kind: "requirement", why: `${ctx.sameFailureElsewhere} other attempts fail this fact with the same assertion (${assertionOf(v.claimed.detail).slice(0, 140)}): the requirement may be wrong or incomplete`, next: "the owner reads the fact's check against what was asked; agents keep trying meanwhile, but only a person changes the fact" };
  }
  return { kind: "implementation", why: `its own fact doesn't hold yet: ${v.claimed.detail.slice(0, 160)}`, next: "keep working on the change, then push" };
}
