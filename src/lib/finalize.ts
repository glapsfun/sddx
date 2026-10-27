// Finalizing a reviewed task: one atomic commit holding the verified code, the
// task state and the receipt, then the merge into the goal's run branch. Reached
// only from a passing review of the exact verified diff (review.ts).
import { existsSync } from "node:fs";
import { readApproval } from "./approval";
import { captureEnv } from "./envinfo";
import { checkedOutAt, commitOnBranch, treeWith } from "./git";
import { findGoalForTask, type Goal } from "./goal";
import type { ProofRecord } from "./proof";
import {
  chainHead,
  type Receipt,
  type ReceiptApproval,
  type ReceiptReview,
  receiptPath,
  sha256,
  validateReceipt,
} from "./receipt";
import { type IntegrationOutcome, integrateTaskIntoRunBranch } from "./runbranch";
import { signPayload, verifySignature } from "./sign";
import { type ReviewEntry, type TaskState, transition } from "./task";
import { isRunBranchScratch } from "./worktree";

export interface FinalizeOptions {
  harness?: string;
  model?: string | null;
  sddxVersion: string;
}

export interface Finalized {
  receiptPath: string;
  commitSha: string;
  integration: IntegrationOutcome;
}

/** `signed` only when the plan's approval token carries a signature that verifies;
 * the signature then travels on the receipt so a clone without the token can check it. */
export function approvalBinding(
  root: string,
  planSha: string,
): Pick<ReceiptApproval, "binding" | "harness_reported" | "signature" | "signer"> {
  const token = readApproval(root, planSha);
  if (!token) return { binding: "unsigned" };
  const harness = token.harness_reported ? { harness_reported: token.harness_reported } : {};
  if (!token.signature || !token.signer) return { binding: "unsigned", ...harness };
  const sig = { signature: token.signature, signer: token.signer };
  return verifySignature(root, planSha, sig, "sddx-approval") === "valid"
    ? { binding: "signed", ...harness, ...sig }
    : { binding: "unsigned", ...harness };
}

function receiptApproval(root: string, goal: Goal, task: TaskState): ReceiptApproval {
  const a = goal.approval;
  if (!a) throw new Error(`goal ${goal.id} has no approval record`);
  return {
    mode: a.mode,
    ...(a.authorization ? { authorization: a.authorization } : {}),
    plan_sha256: a.plan_sha256,
    ...(a.at ? { at: a.at } : {}),
    assumptions: [...(task.assumptions ?? [])],
    amendments: [],
    ...(a.mode === "human"
      ? approvalBinding(root, a.plan_sha256)
      : { binding: "unsigned" as const }),
  };
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Commits and merges a task whose review passed. The commit is built from the
 * proven tree itself plus the two bookkeeping files, never from whatever the
 * worktree holds by then, so a write landing after the review's tree check, an
 * agent's edit under `.sddx/`, or a hook cannot put unproven content in it.
 * Nothing is written until the commit exists: a failure before that leaves the
 * task IN_REVIEW, ready for the review to be recorded again.
 */
export function finalizeTask(
  root: string,
  worktree: string,
  task: TaskState,
  review: ReviewEntry,
  proof: ProofRecord,
  opts: FinalizeOptions,
): Finalized {
  const workspace = task.workspace;
  if (!workspace) throw new Error(`task ${task.id} has no worktree`);
  if (existsSync(receiptPath(worktree, task.id))) {
    throw new Error(`receipt for ${task.id} already exists; receipts are immutable`);
  }
  const goal = findGoalForTask(root, task.id);
  if (!goal) throw new Error(`task ${task.id} belongs to no goal`);
  // the merge goes through a scratch worktree, which git refuses for a branch
  // checked out elsewhere; caught here, before anything is committed
  const holder = checkedOutAt(root, goal.run_branch);
  if (holder && !isRunBranchScratch(holder)) {
    throw new Error(
      `run branch ${goal.run_branch} is checked out at ${holder}, so sddx cannot merge into it. Nothing was committed; switch that checkout to another branch, then record the review again`,
    );
  }

  // the committed state mirrors verify's record, not whatever the task file said
  task.verified = {
    base_sha: proof.base_sha,
    tree_sha: proof.tree_sha,
    test_files: proof.test_files,
    red: proof.red,
    green: proof.green,
    at: proof.at,
  };
  transition(task, "DONE");
  task.updated_at = new Date().toISOString();
  const taskRel = `.sddx/tasks/${task.id}.json`;
  const receiptRel = `.sddx/receipts/${task.id}.json`;
  const taskBytes = json(task);
  const treeSha = treeWith(worktree, proof.tree_sha, { [taskRel]: taskBytes });

  const reviewRecord: ReceiptReview = {
    verdict: "pass",
    diff_sha256: review.diff_sha256,
    reviewer: review.reviewer,
    ...(review.findings_sha256 ? { findings_sha256: review.findings_sha256 } : {}),
    at: review.at,
  };
  const head = chainHead(worktree);
  const profile = task.profile ?? "default";
  const receipt: Receipt = {
    version: 5,
    task_id: task.id,
    seq: head.seq + 1,
    prev: head.prevHash,
    harness: opts.harness ?? "unknown",
    model: opts.model ?? null,
    plugin_version: opts.sddxVersion,
    oracle: { run: proof.oracle.run, expect: proof.oracle.expect },
    runs: proof.green,
    env: captureEnv(worktree),
    base_sha: proof.base_sha,
    tree_sha: treeSha,
    verdict: "pass",
    verified_at: proof.at,
    allow: [...task.allow],
    approval: receiptApproval(root, goal, task),
    spec: { path: task.spec_path, goal_id: task.goal_id },
    boundary: {
      base_sha: proof.base_sha,
      tree_sha: proof.tree_sha,
      test_files: proof.test_files,
      red: proof.red,
    },
    review: reviewRecord,
    profile,
    ...(profile === "strict" ? { strict_runs: [...(task.strict?.runs ?? [])] } : {}),
  };
  const sig = signPayload(worktree, sha256(json(receipt)));
  if (sig) {
    receipt.signature = sig.signature;
    receipt.signer = sig.signer;
  }
  const invalid = validateReceipt(receipt);
  if (invalid.length > 0) {
    throw new Error(`refusing to write invalid receipt: ${invalid.join("; ")}`);
  }

  const commitSha = commitOnBranch({
    worktree,
    branch: workspace.branch,
    baseTree: proof.tree_sha,
    files: { [taskRel]: taskBytes, [receiptRel]: json(receipt) },
    readOnly: [receiptRel],
    message: `sddx(${task.id}): ${task.task}`,
  });

  // The task is DONE and committed from here on. An integration failure leaves
  // the run branch unchanged and is reported, never rethrown as if nothing happened.
  let integration: IntegrationOutcome;
  try {
    integration = integrateTaskIntoRunBranch(worktree, task.id);
  } catch (e) {
    integration = {
      result: "none",
      reason: "error",
      error: (e as Error).message,
      runBranch: goal.run_branch,
    };
  }
  return { receiptPath: receiptPath(worktree, task.id), commitSha, integration };
}
