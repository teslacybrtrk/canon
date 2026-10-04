// Fact scopes: a scoped fact is judged only on worlds that change a matching file.

/** Glob to RegExp: `**` spans directories, `*` stays within one, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a scoped fact applies, given the paths a world changed. No scope, or unknown changes: it applies. */
export function inScope(scope: string[] | null, changed: string[] | null): boolean {
  if (!scope || scope.length === 0 || changed === null) return true;
  const patterns = scope.map(globToRegExp);
  return changed.some((path) => patterns.some((p) => p.test(path)));
}

type TreeEntry = { name: string; hash: string; type: string };
type TreeReader = { readTree(hash: string): Promise<TreeEntry[] | null> };

/** Paths that differ between two Git trees. Identical subtrees (same hash) are skipped, so this is cheap. */
export async function diffTrees(repo: TreeReader, a: string | null, b: string | null, prefix = ""): Promise<string[]> {
  if (a === b) return [];
  const [left, right] = await Promise.all([a ? repo.readTree(a) : [], b ? repo.readTree(b) : []]);
  const l = new Map((left ?? []).map((e) => [e.name, e]));
  const r = new Map((right ?? []).map((e) => [e.name, e]));
  const out: string[] = [];
  for (const name of new Set([...l.keys(), ...r.keys()])) {
    const x = l.get(name);
    const y = r.get(name);
    if (x?.hash === y?.hash) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const xTree = x?.type === "tree" ? x.hash : null;
    const yTree = y?.type === "tree" ? y.hash : null;
    if (xTree || yTree) {
      out.push(...(await diffTrees(repo, xTree, yTree, path)));
      if ((x && !xTree) || (y && !yTree)) out.push(path); // a file replaced by a directory, or back
    } else out.push(path);
  }
  return out;
}
