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
  omitted?: string[]; // changed files the review couldn't show (too large even around each change): coverage is incomplete
  passes: number; // model calls (files per pass x specialists)
  specialists: Specialist[];
}

export interface Review {
  status: "running" | "done" | "none" | "error";
  model: string;
  notes: ReviewNote[];
  dropped: number; // notes the model wrote that quoted nothing in the file
  unresolved?: UnresolvedNote[]; // risk or intent findings among them: unconfirmed, and so not a clean review
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
    "Removed lines count too: if something that mattered was taken out (a guard, a check, a permission test), quote the new line where it used to be and say what is missing.",
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

/** The most lines (old × new, after common lines at both ends are set aside) the line diff will compare. */
export const DIFF_MAX_CELLS = 4_000_000;

/**
 * The change as hunks: lines added (numbered in the new file) and lines removed (numbered in the old file, with where
 * in the new file they were). Order matters: a line moved (a validation taken from before a write to after it) is a
 * removal and an addition, never "nothing changed". Lines the two versions share at the start and the end are set
 * aside first, so a localized change in a large file is diffed exactly; when the changed region itself is too large to
 * diff, `complete` is false and the file can't be represented (its review is unavailable, never a pass).
 * A change that only deletes (a guard taken out) has removed lines and no added ones; both are part of the change.
 */
export function changedLines(base: string, head: string): { added: Array<{ n: number; text: string }>; removed: Array<{ n: number; text: string; at: number }>; complete: boolean } {
  const a = base.split("\n");
  const b = head.split("\n");
  const added: Array<{ n: number; text: string }> = [];
  const removed: Array<{ n: number; text: string; at: number }> = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const m = endA - start, n = endB - start;
  if (m * n > DIFF_MAX_CELLS) return { added: [], removed: [], complete: false };
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[start + i] === b[start + j]) (i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) (removed.push({ n: start + i + 1, text: a[start + i], at: start + j + 1 }), i++);
    else (added.push({ n: start + j + 1, text: b[start + j] }), j++);
  }
  while (i < m) (removed.push({ n: start + i + 1, text: a[start + i], at: Math.min(b.length, start + j + 1) }), i++);
  while (j < n) (added.push({ n: start + j + 1, text: b[start + j] }), j++);
  return { added: added.filter((x) => x.text.trim()), removed: removed.filter((x) => x.text.trim()), complete: true };
}

/**
 * How one file is shown to the reviewer: every added line, every removed line, then the whole new file; or, when the
 * whole file won't fit the budget, the same lists with 20 lines of context around each change, added or removed
 * ("compact"). A deletion-only change is shown too: what was taken out, and where.
 */
export function fileBlock(f: ReviewFile, budget: number): { text: string; compact: boolean; represented: boolean } {
  const { added, removed, complete } = changedLines(f.base, f.head);
  if (!complete) return { text: `FILE ${f.path}\n(the changed region is too large to diff line by line)`, compact: true, represented: false };
  const lines = f.head.split("\n");
  const head = [
    `FILE ${f.path}`,
    `ADDED OR CHANGED LINES:\n${added.map((a) => `${a.n}: ${a.text}`).join("\n") || "(none)"}`,
    ...(removed.length ? [`REMOVED LINES (old line number: text, then where it was in the new file):\n${removed.map((r) => `${r.n}: ${r.text}   [was before new line ${r.at}]`).join("\n")}`] : []),
  ].join("\n");
  const whole = `${head}\nNEW FILE:\n${lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")}`;
  if (whole.length <= budget) return { text: whole, compact: false, represented: true };
  const keep = new Set<number>();
  for (const n of [...added.map((a) => a.n), ...removed.map((r) => r.at)]) for (let i = Math.max(1, n - 20); i <= Math.min(lines.length, n + 20); i++) keep.add(i);
  const shown: string[] = [];
  let prev = 0;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (i !== prev + 1) shown.push("    | …");
    shown.push(`${String(i).padStart(4)}| ${lines[i - 1]}`);
    prev = i;
  }
  return { text: `${head}\nNEW FILE (around each change; the rest is unchanged):\n${shown.join("\n")}`, compact: true, represented: true };
}

/**
 * The review passes a change needs so that every changed file is shown whole or around every change, never cut off:
 * files are packed into passes that each fit the budget. A file too big even in compact form, or whose change can't be
 * diffed, can't be reviewed: it is listed in tooBig, and the review's coverage says it was left out.
 */
export function reviewBatches(files: ReviewFile[], budget = 14_000): { batches: ReviewFile[][]; compact: string[]; tooBig: string[] } {
  const batches: ReviewFile[][] = [];
  const compact: string[] = [];
  const tooBig: string[] = [];
  let cur: ReviewFile[] = [];
  let used = 0;
  for (const f of files) {
    const b = fileBlock(f, budget);
    if (!b.represented || b.text.length > budget) {
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

/** A finding that could govern acceptance (a risk or an intent note) but quoted nothing in the change: not confirmed, not resolved either. */
export interface UnresolvedNote {
  file: string;
  quote: string;
  kind: "risk" | "intent";
  note: string;
  by?: Specialist;
}

/**
 * Keep only notes whose quote is really in that file (nearest match to the line the model gave); count the rest. A risk
 * or intent finding that can't be tied to the code isn't a confirmed violation, but it isn't a clean review either: it
 * comes back as unresolved, so required review evidence can't pass over it. Every grounded risk and intent finding is
 * kept; only "untested" notes are trimmed to make room.
 */
export function ground(raw: unknown, files: ReviewFile[]): { notes: ReviewNote[]; dropped: number; droppedRisk: boolean; unresolved: UnresolvedNote[] } {
  const list = Array.isArray((raw as { notes?: unknown })?.notes) ? ((raw as { notes: unknown[] }).notes as Array<Partial<ReviewNote>>) : [];
  const notes: ReviewNote[] = [];
  const unresolved: UnresolvedNote[] = [];
  let dropped = 0;
  for (const n of list.slice(0, 12)) {
    const file = files.find((f) => f.path === n.file);
    const quote = squash(String(n.quote ?? ""));
    const kind = n.kind === "risk" || n.kind === "untested" || n.kind === "intent" ? n.kind : null;
    const hits = file && quote.length >= 6 ? file.head.split("\n").flatMap((l, i) => (squash(l).includes(quote) ? [i + 1] : [])) : [];
    if (!kind || !n.note || !hits.length) {
      dropped++;
      if ((kind === "risk" || kind === "intent") && n.note) unresolved.push({ file: String(n.file ?? ""), quote: quote.slice(0, 160), kind, note: String(n.note).slice(0, 400) });
      continue;
    }
    const lines = file!.head.split("\n");
    const want = Number(n.line) || hits[0];
    const line = hits.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    notes.push({ file: file!.path, line, quote: squash(lines[line - 1]).slice(0, 160), kind, note: String(n.note).slice(0, 400) });
  }
  // Risks and intent findings can govern acceptance (reviewRisk, intentRisk), so none is ever dropped for room; only
  // "untested" notes are trimmed, to keep at most three notes beside them.
  const governing = notes.filter((n) => n.kind === "risk" || n.kind === "intent");
  const ranked = [...notes.filter((n) => n.kind === "risk"), ...notes.filter((n) => n.kind === "intent"), ...notes.filter((n) => n.kind === "untested").slice(0, Math.max(0, 3 - governing.length))];
  return { notes: ranked, dropped, droppedRisk: unresolved.some((u) => u.kind === "risk"), unresolved };
}

/** The notes across passes: every risk and intent finding (they can decide acceptance), then up to five untested. */
export function rankNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes.filter((n) => n.kind === "risk"), ...notes.filter((n) => n.kind === "intent"), ...notes.filter((n) => n.kind === "untested").slice(0, 5)];
}

/**
 * What a model's answer amounts to. Only a complete answer in the notes format is a review: an empty list of notes is
 * a finding ("nothing to flag"); an answer that was cut off or isn't the format is not, and the review is an error
 * (unavailable evidence), never a silent pass. A risk or intent finding it can't quote from the code comes back as
 * unresolved (see ground), which required review evidence treats as unavailable, not as a clean review.
 */
export function judgeAnswer(answer: unknown, finishReason: string | undefined, files: ReviewFile[]): { ok: true; notes: ReviewNote[]; dropped: number; unresolved: UnresolvedNote[] } | { ok: false; detail: string } {
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
  const { notes, dropped, unresolved } = ground(parsed, files);
  return { ok: true, notes, dropped, unresolved };
}
