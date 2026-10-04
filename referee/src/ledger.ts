import type { CanonFile, Fact, Ledger } from "./protocol";

/**
 * A world's canon.json must be canon plus its claimed fact, unchanged. Facts accepted
 * after the world forked may be missing (behind); anything else is tampering.
 */
export function compareLedger(
  file: CanonFile["facts"],
  canonFacts: Pick<Fact, "id" | "sentence" | "check" | "acceptedAt">[],
  claimed: Pick<Fact, "id" | "sentence" | "check"> | null,
  forkedAt: number,
): Ledger {
  const allowed = new Map<string, Pick<Fact, "id" | "sentence" | "check">>(canonFacts.map((f) => [f.id, f]));
  if (claimed) allowed.set(claimed.id, claimed);
  const inFile = new Set<string>();
  for (const f of file) {
    inFile.add(f.id);
    const truth = allowed.get(f.id);
    if (!truth) return { status: "tampered", detail: `canon.json adds "${f.id}", which this world did not claim` };
    if (stable({ s: f.sentence, c: f.check }) !== stable({ s: truth.sentence, c: truth.check })) {
      return { status: "tampered", detail: `canon.json changes the fact "${f.id}"` };
    }
  }
  if (claimed && !inFile.has(claimed.id)) return { status: "tampered", detail: `canon.json is missing the claimed fact "${claimed.id}"` };
  const missing = canonFacts.filter((f) => !inFile.has(f.id));
  const dropped = missing.filter((f) => (f.acceptedAt ?? 0) <= forkedAt);
  if (dropped.length) return { status: "tampered", detail: `canon.json drops ${dropped.map((f) => f.id).join(", ")}` };
  if (missing.length) {
    return { status: "behind", detail: `canon gained ${missing.map((f) => f.id).join(", ")} after this world forked; declare a fresh world` };
  }
  return { status: "ok", detail: "ok" };
}

/** JSON with sorted keys, so key order in canon.json never counts as a change. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
