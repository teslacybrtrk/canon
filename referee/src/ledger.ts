import type { CanonFile, Fact, FactDef, Ledger } from "./protocol";

type Known = Pick<Fact, "id" | "sentence" | "check"> & { scope?: string[] | null; replaces?: string | null };

/**
 * An attempt's canon.json must be canon plus its claimed fact, unchanged. Facts accepted
 * after the attempt forked may be missing, and facts retired after it forked may linger
 * (both: behind). A revision may drop the fact it replaces. Anything else is tampering.
 */
export function compareLedger(
  file: CanonFile["facts"],
  canonFacts: Array<Known & { acceptedAt?: number | null }>,
  claimed: Known | null,
  forkedAt: number,
  opts: { retiring?: string | null; retired?: Array<Known & { retiredAt?: number | null }> } = {},
): Ledger {
  const allowed = new Map<string, Known>(canonFacts.map((f) => [f.id, f]));
  if (claimed) allowed.set(claimed.id, claimed);
  const retired = new Map((opts.retired ?? []).map((f) => [f.id, f]));
  const inFile = new Set<string>();
  const lingering: string[] = [];
  for (const f of file) {
    inFile.add(f.id);
    const truth = allowed.get(f.id);
    if (!truth) {
      const old = retired.get(f.id);
      if (old && same(f, old) && (old.retiredAt ?? 0) > forkedAt) {
        lingering.push(f.id);
        continue;
      }
      return { status: "tampered", detail: `canon.json adds "${f.id}", which this attempt did not claim` };
    }
    if (!same(f, truth)) return { status: "tampered", detail: `canon.json changes the fact "${f.id}"` };
  }
  if (claimed && !inFile.has(claimed.id)) return { status: "tampered", detail: `canon.json is missing the claimed fact "${claimed.id}"` };
  const missing = canonFacts.filter((f) => !inFile.has(f.id) && f.id !== opts.retiring);
  const dropped = missing.filter((f) => (f.acceptedAt ?? 0) <= forkedAt);
  if (dropped.length) return { status: "tampered", detail: `canon.json drops ${dropped.map((f) => f.id).join(", ")}` };
  if (missing.length || lingering.length) {
    const parts = [
      missing.length ? `canon gained ${missing.map((f) => f.id).join(", ")}` : "",
      lingering.length ? `canon retired ${lingering.join(", ")}` : "",
    ].filter(Boolean);
    return { status: "behind", detail: `${parts.join(" and ")} after this attempt forked; declare a fresh attempt` };
  }
  return { status: "ok", detail: "ok" };
}

function same(a: FactDef | Known, b: Known): boolean {
  const norm = (x: FactDef | Known) => ({ s: x.sentence, c: x.check, scope: x.scope ?? null, replaces: x.replaces ?? null });
  return stable(norm(a)) === stable(norm(b));
}

/** JSON with sorted keys, so key order in canon.json never counts as a change. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
