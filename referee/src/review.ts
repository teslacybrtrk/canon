// A second pair of eyes: an advisory review of a Ready change by a model that didn't write it. The checks already
// passed; the reviewer looks for what they may miss. It never decides anything, and every note must quote the exact
// line it is about: a note whose quote isn't in the file is dropped (and counted), so nothing it says is ungrounded.

export interface ReviewNote {
  file: string;
  line: number;
  quote: string;
  kind: "risk" | "untested" | "intent";
  note: string;
}

export interface Review {
  status: "running" | "done" | "none" | "error";
  model: string;
  notes: ReviewNote[];
  dropped: number; // notes the model wrote that quoted nothing in the file
  detail?: string;
  at: number;
}

export type ReviewFile = { path: string; base: string; head: string };

/** Lines of `head` that aren't in `base` (as a multiset), with 1-based line numbers. */
export function addedLines(base: string, head: string): Array<{ n: number; text: string }> {
  const left = new Map<string, number>();
  for (const l of base.split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const out: Array<{ n: number; text: string }> = [];
  head.split("\n").forEach((text, i) => {
    const k = left.get(text) ?? 0;
    if (k > 0) left.set(text, k - 1);
    else if (text.trim()) out.push({ n: i + 1, text });
  });
  return out;
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          quote: { type: "string" },
          kind: { type: "string", enum: ["risk", "untested", "intent"] },
          note: { type: "string" },
        },
        required: ["file", "line", "quote", "kind", "note"],
      },
    },
  },
  required: ["notes"],
};

/** The messages for the reviewer: the fact the change claims, the facts it must keep, what the checks missed, the code. */
export function reviewPrompt(
  claimed: string,
  canon: string[],
  missed: string[],
  files: ReviewFile[],
  budget = 14_000,
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "You review a code change another AI agent wrote. You did not write it.",
    `It claims to make this fact true: "${claimed}".`,
    `It must keep these facts true: ${canon.map((s) => `"${s}"`).join("; ")}.`,
    "Automated checks of every fact already pass on a live preview. Look for what they may miss.",
    "Report at most 3 notes, each about one line of the NEW code, quoted exactly as it appears (copy the text, 8 to 120 characters).",
    'Kinds: "risk" (a likely bug, race, security hole or data loss), "untested" (behaviour no fact checks, such as a guard nobody would notice was gone), "intent" (the code does something the fact does not ask for).',
    "If deliberate breaks of this change went uncaught, explain the most important one as an \"untested\" note: what could break unnoticed.",
    "Only report what you believe is actually wrong, or actually unchecked. Never report code you think is correct; fewer notes are better than weak ones.",
    "Platform: Cloudflare Workers. Code inside a Durable Object handles one request at a time, and synchronous storage calls with no await between them are atomic, so they cannot race.",
    "No style, naming or formatting comments. If nothing deserves a person's attention, return an empty list.",
  ].join("\n");
  const parts: string[] = [];
  if (missed.length) parts.push(`Deliberate breaks of this change that no fact caught:\n${missed.map((m) => `- ${m}`).join("\n")}`);
  let left = budget;
  for (const f of files) {
    const added = addedLines(f.base, f.head);
    const numbered = f.head.split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
    const block = `FILE ${f.path}\nADDED OR CHANGED LINES:\n${added.map((a) => `${a.n}: ${a.text}`).join("\n")}\nNEW FILE:\n${numbered}`;
    parts.push(block.length > left ? `${block.slice(0, Math.max(0, left))}\n…(truncated)` : block);
    left -= block.length;
    if (left <= 0) break;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The model's answer as an object: already parsed, a JSON string, or JSON inside prose or a code fence. */
export function parseAnswer(answer: unknown): unknown {
  if (answer && typeof answer === "object") return answer;
  if (typeof answer !== "string") return null;
  const text = answer.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try {
      return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Keep only notes whose quote is really in that file (nearest match to the line the model gave); count the rest, and
 * say whether a dropped note was a risk. At most three notes are kept, risks first, so a risk is never cut for room.
 */
export function ground(raw: unknown, files: ReviewFile[]): { notes: ReviewNote[]; dropped: number; droppedRisk: boolean } {
  const list = Array.isArray((raw as { notes?: unknown })?.notes) ? ((raw as { notes: unknown[] }).notes as Array<Partial<ReviewNote>>) : [];
  const notes: ReviewNote[] = [];
  let dropped = 0;
  let droppedRisk = false;
  for (const n of list.slice(0, 12)) {
    const file = files.find((f) => f.path === n.file);
    const quote = squash(String(n.quote ?? ""));
    const kind = n.kind === "risk" || n.kind === "untested" || n.kind === "intent" ? n.kind : null;
    if (!file || quote.length < 6 || !kind || !n.note) {
      dropped++;
      droppedRisk ||= n.kind === "risk";
      continue;
    }
    const lines = file.head.split("\n");
    const hits = lines.flatMap((l, i) => (squash(l).includes(quote) ? [i + 1] : []));
    if (!hits.length) {
      dropped++;
      droppedRisk ||= kind === "risk";
      continue;
    }
    const want = Number(n.line) || hits[0];
    const line = hits.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    notes.push({ file: file.path, line, quote: squash(lines[line - 1]).slice(0, 160), kind, note: String(n.note).slice(0, 400) });
  }
  const ranked = [...notes.filter((n) => n.kind === "risk"), ...notes.filter((n) => n.kind !== "risk")].slice(0, 3);
  return { notes: ranked, dropped, droppedRisk };
}

/**
 * What a model's answer amounts to. Only a complete answer in the notes format is a review: an empty list of notes is
 * a finding ("nothing to flag"); an answer that was cut off, isn't the format, or names a risk it can't quote from the
 * code is not, and the review is an error (unavailable evidence), never a silent pass.
 */
export function judgeAnswer(answer: unknown, finishReason: string | undefined, files: ReviewFile[]): { ok: true; notes: ReviewNote[]; dropped: number } | { ok: false; detail: string } {
  const said = (typeof answer === "string" ? answer : JSON.stringify(answer ?? null)).slice(0, 200);
  if (finishReason === "length") return { ok: false, detail: `the answer was cut off before it finished: ${said}` };
  const parsed = parseAnswer(answer);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { notes?: unknown }).notes)) return { ok: false, detail: `the answer wasn't a list of notes: ${said}` };
  const { notes, dropped, droppedRisk } = ground(parsed, files);
  if (droppedRisk && !notes.some((n) => n.kind === "risk")) return { ok: false, detail: "the reviewer named a risk but quoted no line that is in the code" };
  return { ok: true, notes, dropped };
}
