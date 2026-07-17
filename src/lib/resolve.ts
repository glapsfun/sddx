// Workspace→task resolution for hooks: from an arbitrary path, find the
// governing task without spawning a subprocess. The task file lives inside the
// workspace's own .sddx/ (worktrees carry their copy — see cli task create).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { isTerminal, type TaskState } from "./task";

export type Resolution =
  | { kind: "none" }
  | { kind: "task"; root: string; task: TaskState }
  | { kind: "ambiguous"; root: string; ids: string[] }
  | { kind: "corrupt"; root: string; path: string; error: string };

/** Nearest ancestor (or self) containing .git — a worktree root counts. */
export function workspaceRoot(startPath: string): string | null {
  let dir = resolvePath(startPath);
  try {
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    dir = dirname(dir); // target may not exist yet (Write of a new file)
  }
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Current branch read textually from .git/HEAD (worktree .git files followed). */
export function headBranch(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return null;
      gitDir = resolvePath(root, (m[1] as string).trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? (ref[1] as string) : null;
  } catch {
    return null;
  }
}

function readTaskFile(root: string, id: string): Resolution | null {
  const path = join(root, ".sddx", "tasks", `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return { kind: "task", root, task: JSON.parse(readFileSync(path, "utf8")) as TaskState };
  } catch (e) {
    return { kind: "corrupt", root, path, error: (e as Error).message };
  }
}

export function resolveTask(startPath: string): Resolution {
  const root = workspaceRoot(startPath);
  if (!root || !existsSync(join(root, ".sddx"))) return { kind: "none" };

  // 1. Worktree directory name under .sddx-worktrees/<id>
  if (basename(dirname(root)) === ".sddx-worktrees") {
    const byName = readTaskFile(root, basename(root));
    if (byName) return byName;
  }

  // 2. Branch sddx/<id>
  const branch = headBranch(root);
  if (branch?.startsWith("sddx/")) {
    const byBranch = readTaskFile(root, branch.slice("sddx/".length));
    if (byBranch) return byBranch;
  }

  // 3. Sole non-terminal task in the workspace
  const tasksDir = join(root, ".sddx", "tasks");
  if (!existsSync(tasksDir)) return { kind: "none" };
  const candidates: TaskState[] = [];
  for (const file of readdirSync(tasksDir).filter((f) => f.endsWith(".json"))) {
    const path = join(tasksDir, file);
    let task: TaskState;
    try {
      task = JSON.parse(readFileSync(path, "utf8")) as TaskState;
    } catch (e) {
      return { kind: "corrupt", root, path, error: (e as Error).message };
    }
    if (!isTerminal(task.phase)) candidates.push(task);
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "task", root, task: candidates[0] as TaskState };
  return { kind: "ambiguous", root, ids: candidates.map((t) => t.id).sort() };
}
