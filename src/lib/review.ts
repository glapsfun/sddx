// `sddx review record`: a verdict on exactly the diff `sddx verify` proved. sddx
// cannot judge whether a review was good, but it can make "a passing review of
// the work that was merged" a mechanical fact: the review is refused unless the
// worktree still holds the verified tree, and the record stores that diff's hash.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Finalized, type FinalizeOptions, finalizeTask } from "./finalize";
import { clearProofRecord, diffSha256, readProofRecord, worktreeTree } from "./proof";
import { sha256 } from "./receipt";
import {
  assertV6,
  type ReviewEntry,
  readTask,
  type TaskState,
  taskHome,
  transition,
  writeTask,
} from "./task";
import { resolveMainRepoRoot } from "./worktree";

export interface ReviewInput extends FinalizeOptions {
  verdict: "pass" | "fail";
  findings?: string;
  reviewer?: string;
  cwd: string;
}

export type ReviewOutcome =
  | { kind: "changed"; task: TaskState }
  | { kind: "failed"; task: TaskState; entry: ReviewEntry }
  | ({ kind: "finalized"; task: TaskState; entry: ReviewEntry } & Finalized);

export function recordReview(id: string, input: ReviewInput): ReviewOutcome {
  const root = resolveMainRepoRoot(input.cwd);
  const home = taskHome(root, id);
  if (!home) throw new Error(`no such task: ${id}`);
  const task = readTask(home, id);
  assertV6(task);
  if (task.phase !== "IN_REVIEW") {
    throw new Error(`task ${id} is ${task.phase}; review record requires IN_REVIEW`);
  }
  if (!task.workspace) throw new Error(`task ${id} has no worktree`);
  // the task file is agent-writable; only verify's own record says what was proven
  const proof = readProofRecord(root, id, task.attempt_count);
  if (!proof) {
    throw new Error(
      `task ${id} has no boundary proof recorded by sddx verify for its current attempt; run sddx verify ${id}`,
    );
  }
  const worktree = join(root, task.workspace.path);

  const current = worktreeTree(worktree);
  if (current !== proof.tree_sha) {
    clearProofRecord(root, id);
    task.verified = undefined;
    transition(task, "IN_PROGRESS", "work changed after verify; verify again");
    writeTask(home, task);
    return { kind: "changed", task };
  }

  const entry: ReviewEntry = {
    verdict: input.verdict,
    diff_sha256: diffSha256(root, proof.base_sha, proof.tree_sha),
    tree_sha: proof.tree_sha,
    reviewer: input.reviewer ?? null,
    at: new Date().toISOString(),
  };
  if (input.findings) {
    const abs = resolve(input.cwd, input.findings);
    entry.findings_sha256 = sha256(readFileSync(abs));
    const rel = relative(root, abs);
    entry.findings_path = rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
  }
  task.reviews.push(entry);

  if (input.verdict === "fail") {
    clearProofRecord(root, id);
    task.iterations += 1;
    transition(task, "IN_PROGRESS", "review failed");
    writeTask(home, task);
    return { kind: "failed", task, entry };
  }
  const finalized = finalizeTask(root, worktree, task, entry, proof, input);
  clearProofRecord(root, id);
  return { kind: "finalized", task, entry, ...finalized };
}
