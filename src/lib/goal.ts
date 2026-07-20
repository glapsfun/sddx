import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReceipt } from "./receipt";
import { resolveTaskState, sddxDir, taskId } from "./task";

export interface Goal {
  id: string;
  goal: string;
  task_ids: string[];
  created_at: string;
  updated_at: string;
  /** Set once by `sddx pr create` after a successful PR open. */
  shipped?: { pr_url: string; at: string };
}

export const goalsDir = (cwd: string): string => join(sddxDir(cwd), "goals");
export const goalPath = (cwd: string, id: string): string => join(goalsDir(cwd), `${id}.json`);

/** Same UTC-date-plus-slug derivation as `taskId` — collisions with a task id are
 * harmless since goals and tasks live in separate directories and the goal
 * branch carries a `goal-` prefix that keeps branch names distinct. */
export const goalId = (sentence: string, date = new Date()): string => taskId(sentence, date);

export function createGoal(cwd: string, goalSentence: string, taskIds: string[]): Goal {
  if (taskIds.length === 0) {
    throw new Error("a goal requires at least one task id");
  }
  const now = new Date().toISOString();
  const id = goalId(goalSentence);
  const path = goalPath(cwd, id);
  if (existsSync(path)) throw new Error(`goal ${id} already exists at ${path}`);
  for (const tid of taskIds) {
    if (!resolveTaskState(cwd, tid)) {
      throw new Error(`task ${tid} does not exist — cannot register it in a goal`);
    }
  }
  const g: Goal = { id, goal: goalSentence, task_ids: taskIds, created_at: now, updated_at: now };
  mkdirSync(goalsDir(cwd), { recursive: true });
  writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);
  return g;
}

export function readGoal(cwd: string, id: string): Goal {
  const path = goalPath(cwd, id);
  if (!existsSync(path)) throw new Error(`no such goal: ${id} (${path})`);
  return JSON.parse(readFileSync(path, "utf8")) as Goal;
}

export function writeGoal(cwd: string, g: Goal): void {
  g.updated_at = new Date().toISOString();
  writeFileSync(goalPath(cwd, g.id), `${JSON.stringify(g, null, 2)}\n`);
}

export interface GoalCompleteness {
  complete: boolean;
  blocking: Array<{ task_id: string; reason: string }>;
}

/**
 * Re-reads every task fresh at call time — never trusts a goal-time snapshot.
 * All-or-nothing: any task missing, incomplete, or without a passing receipt
 * blocks the whole goal.
 */
export function checkGoalComplete(cwd: string, id: string): GoalCompleteness {
  const g = readGoal(cwd, id);
  const blocking: Array<{ task_id: string; reason: string }> = [];
  for (const tid of g.task_ids) {
    const task = resolveTaskState(cwd, tid);
    if (!task) {
      blocking.push({ task_id: tid, reason: "task state not found" });
      continue;
    }
    if (task.phase !== "DONE") {
      blocking.push({ task_id: tid, reason: `phase ${task.phase}` });
      continue;
    }
    const receipt = resolveReceipt(cwd, tid);
    if (!receipt) {
      blocking.push({ task_id: tid, reason: "no receipt" });
      continue;
    }
    if (receipt.verdict !== "pass") {
      blocking.push({ task_id: tid, reason: `receipt verdict ${receipt.verdict}` });
    }
  }
  return { complete: blocking.length === 0, blocking };
}
