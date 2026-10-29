// `sddx verify`: the boundary proof for one IN_PROGRESS task. A pass moves the
// task to IN_REVIEW and records what was proven; nothing is committed and no
// receipt is written here, because a task is not finished until a review of
// exactly this diff passes (see review.ts and finalize.ts).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { classify, normalizeRelPath } from "./classify";
import { classifyConfig, maxIterations, oracleRuns, profile, stuckThreshold } from "./config";
import { globMatch } from "./glob";
import { readGoal } from "./goal";
import { parseGoalSpec } from "./goalspec";
import {
  changedFiles,
  clearProofRecord,
  runBoundaryProof,
  sddxChanges,
  worktreeTree,
  writeProofRecord,
} from "./proof";
import { sha256 } from "./receipt";
import { assertV6, readTask, type TaskState, taskHome, transition, writeTask } from "./task";
import { resolveMainRepoRoot } from "./worktree";

export interface VerifyOutcome {
  verdict: "pass" | "fail";
  task: TaskState;
  treeSha: string;
  message: string;
  stuck: boolean;
  limitReached: boolean;
}

/** Implementation files the diff changes outside the task's scope. */
export function outOfScope(task: TaskState, paths: string[], root: string): string[] {
  if (task.scope.length === 0) return [];
  const cfg = classifyConfig(root);
  return paths.filter((p) => {
    if (classify(p, task.allow, cfg).rule !== "implementation") return false;
    const path = normalizeRelPath(p);
    return !task.scope.some((g) => globMatch(normalizeRelPath(g), path));
  });
}

/**
 * Refuses a task file whose oracle or scope differs from the approved spec. The
 * task file lives in the worktree an agent edits, so the spec bytes whose hash
 * the goal's approval recorded are what decide what verify runs and allows.
 */
export function assertMatchesApprovedSpec(root: string, task: TaskState): void {
  const goal = readGoal(root, task.goal_id);
  const approved = goal.approval?.plan_sha256;
  if (!approved) throw new Error(`goal ${goal.id} has no approval record`);
  const shown = spawnSync("git", ["show", `${goal.run_branch}:${goal.spec_path}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (shown.status !== 0) {
    throw new Error(
      `cannot read the approved spec ${goal.spec_path} from run branch ${goal.run_branch}: ${shown.stderr.toString().trim()}`,
    );
  }
  if (sha256(shown.stdout) !== approved) {
    throw new Error(
      `the spec on ${goal.run_branch} (${goal.spec_path}) no longer matches the approved plan ${approved.slice(0, 12)}`,
    );
  }
  const spec = parseGoalSpec(shown.stdout.toString("utf8")).spec;
  const planned = spec?.tasks.find((t) => t.id === task.id);
  if (!planned) throw new Error(`task ${task.id} is not in the approved spec ${goal.spec_path}`);
  for (const key of ["oracle", "scope"] as const) {
    if (JSON.stringify(planned[key]) !== JSON.stringify(task[key])) {
      throw new Error(
        `task ${task.id}'s ${key} in its state file differs from the approved spec ${goal.spec_path}; the approved plan decides what verify runs`,
      );
    }
  }
}

/** Locates a task and checks it may be verified, throwing a user-facing message otherwise. */
export function loadForVerify(
  cwd: string,
  id: string,
): { root: string; home: string; task: TaskState } {
  const root = resolveMainRepoRoot(cwd);
  const home = taskHome(root, id);
  if (!home) throw new Error(`no such task: ${id}`);
  const task = readTask(home, id);
  assertV6(task);
  if (task.phase !== "IN_PROGRESS") {
    throw new Error(`task ${id} is ${task.phase}; verify requires IN_PROGRESS`);
  }
  if (task.oracle.type === "manual") {
    throw new Error(
      `task ${id} has a manual oracle, which needs a human to observe the result; sddx verify only runs executable oracles`,
    );
  }
  if (!task.workspace) throw new Error(`task ${id} has no worktree; run sddx task start ${id}`);
  const current = profile(root);
  if (task.profile !== undefined && task.profile !== current) {
    throw new Error(
      `task ${id} was started under the ${task.profile} profile but the config now says ${current}; a task is gated by one profile from start to finish. Restore the profile, or abandon the task and start it again`,
    );
  }
  assertMatchesApprovedSpec(root, task);
  return { root, home, task };
}

export function verifyTask(cwd: string, id: string): VerifyOutcome {
  const { root, home, task } = loadForVerify(cwd, id);
  clearProofRecord(root, id);
  const workspace = task.workspace as NonNullable<TaskState["workspace"]>;
  const worktree = join(root, workspace.path);
  const treeSha = worktreeTree(worktree);
  const base = workspace.base_sha;
  const now = new Date().toISOString();
  task.iterations += 1;
  const limitReached = task.iterations >= maxIterations(root);

  const finishFail = (
    half: "red" | "green" | "setup" | "scope",
    exitCode: number,
    message: string,
    fingerprint: string,
  ): VerifyOutcome => {
    task.last_failure = { half, exit_code: exitCode, message, at: now };
    task.stuck =
      task.stuck?.fingerprint === fingerprint
        ? { ...task.stuck, count: task.stuck.count + 1 }
        : { fingerprint, count: 1, since: now };
    const stuck = task.stuck.count >= stuckThreshold(root);
    writeTask(home, task);
    return { verdict: "fail", task, treeSha, message, stuck, limitReached };
  };

  const stateChanges = sddxChanges(root, base, treeSha);
  if (stateChanges.length > 0) {
    return finishFail(
      "scope",
      1,
      `changes under .sddx/ are sddx's own state and never part of a task: ${stateChanges.join(", ")}`,
      `sddx\0${stateChanges.join("\0")}`,
    );
  }

  const offScope = outOfScope(
    task,
    changedFiles(root, base, treeSha).map((f) => f.path),
    root,
  );
  if (offScope.length > 0) {
    return finishFail(
      "scope",
      1,
      `changes outside task ${id}'s scope (${task.scope.join(", ")}): ${offScope.join(", ")}`,
      `scope\0${offScope.join("\0")}`,
    );
  }

  const result = runBoundaryProof({
    root,
    id,
    base,
    tree: treeSha,
    oracle: task.oracle,
    runs: oracleRuns(root, task.oracle.runs),
    classify: classifyConfig(root),
  });
  if (!result.ok)
    return finishFail(result.half, result.exitCode, result.message, result.fingerprint);

  task.verified = {
    base_sha: base,
    tree_sha: treeSha,
    test_files: result.testFiles,
    red: result.red,
    green: result.green,
    at: now,
  };
  writeProofRecord(root, {
    task_id: id,
    attempt: task.attempt_count,
    oracle: task.oracle,
    ...task.verified,
  });
  task.last_failure = undefined;
  task.stuck = undefined;
  transition(task, "IN_REVIEW");
  writeTask(home, task);
  return {
    verdict: "pass",
    task,
    treeSha,
    message: `boundary proof passed: RED exit ${result.red.exit_code} on the base plus ${result.testFiles.length} test file(s), GREEN ${result.green.length} run(s) on tree ${treeSha}`,
    stuck: false,
    limitReached,
  };
}
