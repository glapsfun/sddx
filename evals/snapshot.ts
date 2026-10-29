// The end state of one session, collected once so graders stay pure functions.
// Changed paths compare a tree of the whole working copy (tracked and
// untracked, ignored files aside) against the same tree taken right after the
// fixture was built, so committed and uncommitted edits both count.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "./fixtures";
import type { Snapshot, SpecSnapshot, TaskSnapshot, Transcript } from "./types";

type Sddx = (cwd: string, ...args: string[]) => RunResult;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", ...(env ? { env } : {}) });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git tree of everything in `dir` that is not ignored, leaving the real index alone. */
export function workingTree(dir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "sddx-evals-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    git(dir, ["add", "-A"], env);
    git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", ".sddx-worktrees"], env);
    return git(dir, ["write-tree"], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function changedSince(dir: string, base: string): string[] {
  const now = workingTree(dir);
  if (now === base) return [];
  return git(dir, ["diff-tree", "-r", "--name-only", base, now]).split("\n").filter(Boolean);
}

function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

function taskIds(dir: string): string[] {
  const ids = new Set(jsonFiles(join(dir, ".sddx", "tasks")).map((f) => f.slice(0, -5)));
  const trees = join(dir, ".sddx-worktrees");
  for (const wt of existsSync(trees) ? readdirSync(trees) : []) {
    for (const f of jsonFiles(join(trees, wt, ".sddx", "tasks"))) ids.add(f.slice(0, -5));
  }
  return [...ids].sort();
}

function task(dir: string, id: string, sddx: Sddx): TaskSnapshot {
  const r = sddx(dir, "task", "show", id, "--output", "json");
  let t: Record<string, unknown> = {};
  try {
    t = JSON.parse(r.stdout).data ?? {};
  } catch {
    // an unreadable task reads as phase "unknown" below
  }
  const reviews = Array.isArray(t.reviews) ? (t.reviews as { reviewer?: string | null }[]) : [];
  const strict = (t.strict ?? {}) as { runs?: { test_exit?: number }[] };
  return {
    id,
    phase: typeof t.phase === "string" ? t.phase : "unknown",
    verified: t.verified !== undefined,
    reviewers: reviews.map((x) => x.reviewer ?? "").filter(Boolean),
    strictExits: (strict.runs ?? []).map((x) => x.test_exit ?? -1),
  };
}

function spec(dir: string, path: string, sddx: Sddx): SpecSnapshot {
  const text = readFileSync(join(dir, path), "utf8");
  return {
    path,
    check: sddx(dir, "spec", "check", path).status ?? -1,
    planCheck: sddx(dir, "plan", "check", path).status ?? -1,
    hasTasks: /^## Tasks\s*$/m.test(text) && /^```sddx\s*$/m.test(text),
  };
}

export function snapshot(
  dir: string,
  base: string,
  sddx: Sddx,
  transcript: Transcript,
  marker: string | null,
): Snapshot {
  const changed = changedSince(dir, base);
  const goals = git(dir, ["for-each-ref", "--format=%(refname:lstrip=3)", "refs/sddx/goals/"])
    .split("\n")
    .filter(Boolean);
  const specs = changed
    .filter((p) => /^\.sddx\/specs\/[^/]+\.md$/.test(p) && existsSync(join(dir, p)))
    .map((p) => spec(dir, p, sddx));
  let audit: Snapshot["audit"] = null;
  if (goals.length > 0) {
    const r = sddx(dir, "audit", "--ci");
    audit = { exit: r.status ?? -1, output: `${r.stdout}${r.stderr}`.trim() };
  }
  return {
    changed,
    sddxDir: existsSync(join(dir, ".sddx")),
    approvals: existsSync(join(dir, ".sddx", "approvals"))
      ? readdirSync(join(dir, ".sddx", "approvals")).sort()
      : [],
    goals,
    specs,
    tasks: taskIds(dir).map((id) => task(dir, id, sddx)),
    audit,
    decoyCalled: marker !== null && existsSync(marker),
    commands: transcript.commands,
    reply: transcript.reply,
  };
}
