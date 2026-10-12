// Bounded automatic repair. When the judge re-applies an attempt on a newer canon and Git stops at a text conflict, a
// model resolves the conflict markers. The result is only a candidate: it must keep every line outside the conflicts
// exactly (in order), leave no markers, and then pass every fact on its own preview like any push. A bad repair is
// rejected by the facts and never lands; the agent is no worse off than with the conflict.

export type Hunk = { ours: string; theirs: string };

/** Splits a file with conflict markers into the text outside the conflicts and the conflicting hunks. */
export function parseConflicts(text: string): { outside: string[]; hunks: Hunk[] } | null {
  const lines = text.split("\n");
  const outside: string[] = [];
  const hunks: Hunk[] = [];
  let cur: string[] = [];
  let mode: "out" | "ours" | "base" | "theirs" = "out";
  let ours: string[] = [];
  let theirs: string[] = [];
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      if (mode !== "out") return null;
      outside.push(cur.join("\n"));
      cur = [];
      ours = [];
      theirs = [];
      mode = "ours";
    } else if (line.startsWith("|||||||") && mode === "ours") mode = "base";
    else if (line.startsWith("=======") && (mode === "ours" || mode === "base")) mode = "theirs";
    else if (line.startsWith(">>>>>>>") && mode === "theirs") {
      hunks.push({ ours: ours.join("\n"), theirs: theirs.join("\n") });
      mode = "out";
    } else if (mode === "out") cur.push(line);
    else if (mode === "ours") ours.push(line);
    else if (mode === "theirs") theirs.push(line);
  }
  if (mode !== "out" || !hunks.length) return null;
  outside.push(cur.join("\n"));
  return { outside, hunks };
}

/** A resolution is acceptable only if no markers are left and every outside segment survives, in order. */
export function validResolution(conflicted: string, resolved: string): boolean {
  if (/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(resolved)) return false;
  const parsed = parseConflicts(conflicted);
  if (!parsed) return false;
  let at = 0;
  for (const seg of parsed.outside.map((s) => s.trim()).filter(Boolean)) {
    const found = resolved.indexOf(seg, at);
    if (found < 0) return false;
    at = found + seg.length;
  }
  return resolved.trim().length > 0;
}

export function repairPrompt(path: string, conflicted: string, intents: string[]): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You resolve a Git text conflict. Two changes were made to the same lines; both must survive.",
        `What each side is for: ${intents.map((s) => `"${s}"`).join("; ")}.`,
        "Return the whole file with every conflict resolved so both changes work together. Keep every line outside the conflict markers exactly as it is.",
        "No markers, no commentary, no code fences: only the file's text.",
      ].join("\n"),
    },
    { role: "user", content: `FILE ${path}\n${conflicted}` },
  ];
}

/** The model's answer as file text: strips a code fence if it added one anyway. */
export function fileFromAnswer(answer: unknown): string | null {
  if (typeof answer !== "string") return null;
  const fenced = answer.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return (fenced ? fenced[1] : answer).replace(/\s+$/, "") + "\n";
}
