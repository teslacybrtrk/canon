// A second pair of eyes: an advisory review of a Ready change by a model that didn't write it. The checks already
// passed; the reviewer looks for what they may miss. It never decides anything, and every note must quote the exact
// line it is about: a note whose quote isn't in the file is dropped (and counted), so nothing it says is ungrounded.

export interface ReviewNote {
  file: string;
  line: number;
  quote: string;
  kind: "risk" | "untested" | "intent";
  note: string;
  by?: Specialist; // which specialist pass wrote it
}

// Specialist reviews: the general pass always runs; a change that touches stored data also gets a data pass, and one
// that touches authentication, permissions, secrets or anything the charter routes to review gets a security pass.
export type Specialist = "general" | "data" | "security";
export const SPECIALIST_FOCUS: Record<Specialist, string> = {
  general: "",
  data: "You are the data specialist. Focus only on stored data: migrations and schema changes, whether the previous version of the app can still read what this version writes (a rollback runs old code on new data), lost or corrupted writes, missing transactions, writes that aren't idempotent when a request is retried.",
  security: "You are the security specialist. Focus only on security: authentication and authorization (who may do what), injection (SQL, HTML, headers), secrets in code or logs, trusting client input, and anything that widens who can read or change data.",
};

/** Which specialist passes a change gets, from what it touches. The general pass is always first. */
export function specialistsFor(files: Array<{ path: string; added: string[] }>, touchesData: boolean, reviewPaths: (p: string) => boolean): Specialist[] {
  const out: Specialist[] = ["general"];
  const text = files.flatMap((f) => f.added).join("\n");
  if (touchesData || files.some((f) => /(^|\/)(migrations?|schema|db)\//i.test(f.path) || /\.sql$/.test(f.path))) out.push("data");
  const auth = /\b(auth\w*|permission|role|admin|session|token|password|secret|cookie|bearer|jwt|csrf|cors)\b/i;
  if (files.some((f) => reviewPaths(f.path) || auth.test(f.path)) || auth.test(text)) out.push("security");
  return out;
}

export interface ReviewCoverage {
  files: number; // source files the change touches
  reviewed: number; // shown to the reviewer whole or around every change
  compact: string[]; // shown around each change, not whole
  passes: number; // model calls (files per pass x specialists)
  specialists: Specialist[];
}

export interface Review {
  status: "running" | "done" | "none" | "error";
  model: string;
  notes: ReviewNote[];
  dropped: number; // notes the model wrote that quoted nothing in the file
  detail?: string;
  at: number;
  coverage?: ReviewCoverage; // what the review actually covered: a "done" review covered every changed source file
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
  specialist: Specialist = "general",
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
    ...(SPECIALIST_FOCUS[specialist] ? [SPECIALIST_FOCUS[specialist]] : []),
  ].join("\n");
  const parts: string[] = [];
  if (missed.length) parts.push(`Deliberate breaks of this change that no fact caught:\n${missed.map((m) => `- ${m}`).join("\n")}`);
  // Nothing is cut here: reviewBatches already split the change into passes that each fit the budget whole.
  for (const f of files) parts.push(fileBlock(f, budget).text);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/**
 * How one file is shown to the reviewer: every added or changed line, then the whole new file; or, when the whole file
 * won't fit the budget, every added line with 20 lines of context around each ("compact"). Too big even then: null.
 */
export function fileBlock(f: ReviewFile, budget: number): { text: string; compact: boolean } {
  const added = addedLines(f.base, f.head);
  const lines = f.head.split("\n");
  const head = `FILE ${f.path}\nADDED OR CHANGED LINES:\n${added.map((a) => `${a.n}: ${a.text}`).join("\n")}`;
  const whole = `${head}\nNEW FILE:\n${lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")}`;
  if (whole.length <= budget) return { text: whole, compact: false };
  const keep = new Set<number>();
  for (const a of added) for (let i = Math.max(1, a.n - 20); i <= Math.min(lines.length, a.n + 20); i++) keep.add(i);
  const shown: string[] = [];
  let prev = 0;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (i !== prev + 1) shown.push("    | …");
    shown.push(`${String(i).padStart(4)}| ${lines[i - 1]}`);
    prev = i;
  }
  return { text: `${head}\nNEW FILE (around each change; the rest is unchanged):\n${shown.join("\n")}`, compact: true };
}

/**
 * The review passes a change needs so that every changed file is shown whole or around every change, never cut off:
 * files are packed into passes that each fit the budget. A file too big even in compact form can't be reviewed.
 */
export function reviewBatches(files: ReviewFile[], budget = 14_000): { batches: ReviewFile[][]; compact: string[]; tooBig: string[] } {
  const batches: ReviewFile[][] = [];
  const compact: string[] = [];
  const tooBig: string[] = [];
  let cur: ReviewFile[] = [];
  let used = 0;
  for (const f of files) {
    const b = fileBlock(f, budget);
    if (b.text.length > budget) {
      tooBig.push(f.path);
      continue;
    }
    if (b.compact) compact.push(f.path);
    if (used + b.text.length > budget && cur.length) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(f);
    used += b.text.length;
  }
  if (cur.length) batches.push(cur);
  return { batches, compact, tooBig };
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
  // Every entry must be a whole note in the schema: one malformed entry makes the answer unusable, never quietly fewer notes.
  const entries = (parsed as { notes: unknown[] }).notes;
  const bad = entries.findIndex((n) => {
    const e = n as Record<string, unknown> | null;
    return !e || typeof e !== "object" || Array.isArray(e) || typeof e.file !== "string" || !Number.isInteger(e.line) || typeof e.quote !== "string" || !["risk", "untested", "intent"].includes(e.kind as string) || typeof e.note !== "string" || !e.note.trim();
  });
  if (bad >= 0) return { ok: false, detail: `note ${bad + 1} isn't a whole note (file, line, quote, kind, note): ${JSON.stringify(entries[bad]).slice(0, 120)}` };
  if (entries.length > 12) return { ok: false, detail: `the answer has ${entries.length} notes, more than the 3 asked for` };
  const { notes, dropped, droppedRisk } = ground(parsed, files);
  if (droppedRisk && !notes.some((n) => n.kind === "risk")) return { ok: false, detail: "the reviewer named a risk but quoted no line that is in the code" };
  return { ok: true, notes, dropped };
}
