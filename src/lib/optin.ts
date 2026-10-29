// Whether a session is opted in to sddx: a `.sddx/` directory in its working
// directory or an ancestor up to the git working-tree root. Outside a git
// working tree only the working directory itself counts. `hooks/run-hook`
// implements the same rule in shell; tests/session-router.test.ts holds both to
// one table of cases.
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workspaceRoot } from "./resolve";

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The directory holding the `.sddx/` that opts `cwd` in, or null. */
export function optedInRoot(cwd: string): string | null {
  const start = resolve(cwd);
  const top = workspaceRoot(start);
  if (top === null) return isDir(join(start, ".sddx")) ? start : null;
  for (let d = start; ; d = dirname(d)) {
    if (isDir(join(d, ".sddx"))) return d;
    if (d === top) return null;
  }
}
