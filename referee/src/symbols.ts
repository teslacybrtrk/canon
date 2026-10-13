// Which functions a change touches. Overlap by file is noise when an app lives in one file (every agent "changes
// src/index.ts"); overlap by function says who is really in your way: "agent-3 is changing reserve() too".
// A line-level heuristic for TypeScript and JavaScript: good enough to point, never used to decide anything.

const DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // function name(
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, // class Name
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, // a top-level const name = (not locals)
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(.*\)\s*(?::.*)?\{\s*$/, // method(...): Type {
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with"]);

const indent = (line: string) => line.length - line.trimStart().length;

/** The innermost declaration enclosing each line (by indentation), or null at the top level. */
function owners(lines: string[]): Array<string | null> {
  const stack: Array<{ name: string; depth: number }> = [];
  return lines.map((line) => {
    if (!line.trim()) return stack.at(-1)?.name ?? null;
    const depth = indent(line);
    while (stack.length && depth <= stack.at(-1)!.depth && !/^\s*[}\])]/.test(line)) stack.pop();
    for (const re of DECL) {
      const m = line.match(re);
      if (m && !KEYWORDS.has(m[1])) {
        const parent = stack.at(-1)?.name;
        stack.push({ name: parent && /^\s*(?:public|private|protected|static|async|[A-Za-z_$])/.test(line) && depth > 0 ? `${parent}.${m[1]}` : m[1], depth });
        break;
      }
    }
    return stack.at(-1)?.name ?? null;
  });
}

/** Lines of a and of b that are not in their longest common subsequence (null for very large files). */
function diffLines(a: string[], b: string[]): { removed: number[]; added: number[] } | null {
  const n = a.length;
  const m = b.length;
  if (n * m > 9_000_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(i++);
    else added.push(j++);
  }
  while (i < n) removed.push(i++);
  while (j < m) added.push(j++);
  return { removed, added };
}

/** Functions (and classes, top-level consts) whose lines differ between two versions of a file. */
export function changedSymbols(base: string, head: string): string[] {
  const a = base.split("\n");
  const b = head.split("\n");
  const d = diffLines(a, b);
  if (!d) return [];
  const ownA = owners(a);
  const ownB = owners(b);
  const out = new Set<string>();
  for (const i of d.added) if (b[i].trim() && ownB[i]) out.add(ownB[i]!);
  for (const i of d.removed) if (a[i].trim() && ownA[i]) out.add(ownA[i]!);
  return [...out].sort();
}

/**
 * The lines a change adds (by the same diff). A file too large for the line diff is never "nothing added": it falls
 * back to counting lines, so any line that appears more often in `head` than in `base` counts as added (every truly new
 * line is among them). Data inspection relies on this, so a big file can't hide a DROP TABLE.
 */
export function addedText(base: string, head: string): string[] {
  const a = base.split("\n");
  const b = head.split("\n");
  const d = diffLines(a, b);
  if (d) return d.added.map((i) => b[i]).filter((l) => l.trim());
  const left = new Map<string, number>();
  for (const l of a) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of b) {
    const k = left.get(l) ?? 0;
    if (k > 0) left.set(l, k - 1);
    else if (l.trim()) out.push(l);
  }
  return out;
}

/**
 * Which of `changed` (symbols someone else is changing, e.g. "Market.addToCart") these added lines call. Matched by
 * the last name segment followed by "(", so `market.addToCart(...)` counts as a call of Market.addToCart.
 */
export function callsInto(added: string[], changed: string[]): string[] {
  const out = new Set<string>();
  for (const sym of changed) {
    const name = sym.split(".").pop()!;
    if (name.length < 3 || name === "constructor") continue;
    const call = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}\\s*\\(`);
    if (added.some((l) => call.test(l) && !new RegExp(`^\\s*(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`).test(l))) out.add(sym);
  }
  return [...out].sort();
}
