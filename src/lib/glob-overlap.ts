// STRICT glob-overlap detection for write scopes. Two globs are treated as
// DISJOINT only when no path can match both; any residual uncertainty resolves
// to OVERLAP. Conservative by design — forcing an order between two tasks that
// were actually disjoint is merely slower, while missing a real overlap risks a
// concurrent write conflict. New files do not exist at plan time, so this is a
// glob-vs-glob decision, never an expansion against the working tree.
//
// Grammar matches src/lib/glob.ts: `*` and `?` stay within a path segment, `**`
// spans zero or more segments (kept conservative — trailing `**` is allowed to
// match zero here, unlike globMatch, so uncertainty leans toward overlap).

function segments(glob: string): string[] {
  return glob
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter((s) => s !== "");
}

/** Do two single-segment patterns (`*`, `?`, literals — no slashes) share any
 * matching string? Standard wildcard intersection, memoized on char indices. */
function segmentsOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res: boolean;
    if (i === a.length && j === b.length) res = true;
    else if (i < a.length && a[i] === "*") res = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === "*") res = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) res = false;
    else {
      const ca = a[i] as string;
      const cb = b[j] as string;
      res = ca === "?" || cb === "?" || ca === cb ? go(i + 1, j + 1) : false;
    }
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

/** Can any path match both segment lists? `**` spans zero+ segments on either
 * side; a proven literal-segment mismatch is the only way to disprove overlap. */
function listsOverlap(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res: boolean;
    if (i === a.length && j === b.length) res = true;
    else if (i < a.length && a[i] === "**") res = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === "**") res = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) res = false;
    else res = segmentsOverlap(a[i] as string, b[j] as string) && go(i + 1, j + 1);
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

/** True unless the two globs are provably disjoint (STRICT). */
export function overlaps(a: string, b: string): boolean {
  return listsOverlap(segments(a), segments(b));
}

/**
 * True if two write scopes could collide. An empty scope means the task is
 * **unconfined** — it may write anywhere (the tdd-gate does not confine it) — so
 * a single empty side conflicts with any non-empty sibling and must be ordered.
 * Only when BOTH sides are empty do we defer to the pre-scope trust model (the
 * legacy all-root, no-scope goal), treating them as non-overlapping.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return false;
  if (a.length === 0 || b.length === 0) return true;
  for (const ga of a) {
    for (const gb of b) {
      if (overlaps(ga, gb)) return true;
    }
  }
  return false;
}
