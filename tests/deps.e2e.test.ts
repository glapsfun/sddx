import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { blockedOn, resolveTaskState, type TaskState } from "../src/lib/task";
import { fixtureClone } from "./fixtures";
import { completeTask, createRun, readTaskState, sddx, startTask } from "./helpers";

// each test drives whole tasks through the CLI, which can exceed the 5s default under load
setDefaultTimeout(60_000);

const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const stateOf = (cwd: string, id: string): TaskState => {
  const t = resolveTaskState(cwd, id);
  if (!t) throw new Error(`no state for ${id}`);
  return t;
};

describe("dependency chain end-to-end", () => {
  test("a dependent is blocked until its parent is DONE, then forks from the parent's commit", () => {
    const { clone } = fixtureClone();
    // T2's scope overlaps T1's: legal only because T2 depends on T1
    createRun(clone, {
      tasks: [
        { id: "T1", scope: ["T1.done", "src/db/**"] },
        { id: "T2", scope: ["T2.done", "src/db/schema.ts"], dependsOn: ["T1"] },
      ],
    });

    expect(blockedOn(clone, stateOf(clone, "T2"))).toBe("T1");
    const early = sddx(clone, "task", "start", "T2");
    expect(early.status).toBe(1);
    expect(early.stderr).toContain("dependency T1 is PLANNED, not DONE");
    expect(existsSync(join(clone, ".sddx-worktrees", "T2"))).toBe(false);

    completeTask(clone, "T1");
    expect(stateOf(clone, "T1").phase).toBe("DONE");
    expect(blockedOn(clone, stateOf(clone, "T2"))).toBeNull();

    const wt = startTask(clone, "T2");
    expect(wt).toBe(join(clone, ".sddx-worktrees", "T2"));
    const parentTip = g(clone, "rev-parse", "sddx/T1");
    expect(g(wt, "rev-parse", "HEAD")).toBe(parentTip);

    // the PLANNED copy in the main checkout is gone; the live state is the worktree's
    expect(existsSync(join(clone, ".sddx", "tasks", "T2.json"))).toBe(false);
    expect(stateOf(clone, "T2").workspace?.base_sha).toBe(parentTip);
  });
});

describe("fan-in dependency end-to-end", () => {
  test("a two-parent fan-in child starts from a clean merge of both DONE commits", () => {
    const { clone } = fixtureClone();
    createRun(clone, {
      tasks: [
        { id: "T1", scope: ["T1.done", "src/a/**"] },
        { id: "T2", scope: ["T2.done", "src/b/**"] },
        { id: "T3", scope: ["T3.done", "src/d/**"], dependsOn: ["T1", "T2"] },
      ],
    });
    expect(blockedOn(clone, stateOf(clone, "T3"))).toBe("T1");

    completeTask(clone, "T1");
    // still blocked on T2 even though T1 is DONE
    expect(blockedOn(clone, stateOf(clone, "T3"))).toBe("T2");
    completeTask(clone, "T2");
    expect(blockedOn(clone, stateOf(clone, "T3"))).toBeNull();

    const wt = startTask(clone, "T3");
    const aSha = g(clone, "rev-parse", "sddx/T1");
    const bSha = g(clone, "rev-parse", "sddx/T2");
    const head = g(wt, "rev-parse", "HEAD");
    const parents = g(wt, "log", "-1", "--format=%P", head).split(" ").filter(Boolean);
    expect(parents).toEqual([aSha, bSha]);
    expect(stateOf(clone, "T3").workspace?.base_sha).toBe(head);
  });
});

describe("retry end-to-end", () => {
  test("a fresh retry returns a failed task to PLANNED, then abandons once attempts are exhausted", () => {
    const { clone } = fixtureClone();
    const run = createRun(clone, {
      tasks: [{ id: "T1", extra: "retry: {max_attempts: 2, workspace: fresh}" }],
    });
    const wt = startTask(clone, "T1");
    const originalBase = stateOf(clone, "T1").workspace?.base_sha;
    expect(originalBase).toBe(g(clone, "rev-parse", run.runBranch));
    // a failing verify leaves a failure record the retry must not carry over
    expect(sddx(clone, "verify", "T1").status).toBe(1);
    expect(readTaskState(clone, "T1").last_failure).toBeDefined();

    const first = sddx(clone, "task", "abandon", "T1", "--reason", "broken attempt");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("retry 2/2");
    const afterRetry = stateOf(clone, "T1");
    expect(afterRetry.phase).toBe("PLANNED");
    expect(afterRetry.attempt_count).toBe(2);
    expect(afterRetry.iterations).toBe(0);
    expect(afterRetry.last_failure).toBeUndefined();
    expect(afterRetry.stuck).toBeUndefined();
    expect(afterRetry.workspace).toBeUndefined();

    // the next attempt forks again from the same base, with nothing left over
    expect(startTask(clone, "T1")).toBe(wt);
    expect(g(wt, "rev-parse", "HEAD")).toBe(originalBase as string);
    expect(stateOf(clone, "T1").workspace?.base_sha).toBe(originalBase as string);

    const second = sddx(clone, "task", "abandon", "T1", "--reason", "still broken");
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("retry");
    expect(stateOf(clone, "T1").phase).toBe("ABANDONED");
  });
});
