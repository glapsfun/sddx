import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonOrRetry,
  blockedOn,
  createPlannedTask,
  dependsOnList,
  failurePolicyOf,
  isStarted,
  isV6Task,
  type PlannedTaskInput,
  readTask,
  resolveTaskState,
  retryPolicyOf,
  skippedOn,
  type TaskState,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-task-"));
}

/** A PLANNED task file, the shape `plan start` writes for each spec task. */
function plant(cwd: string, id: string, input: Partial<PlannedTaskInput> = {}): TaskState {
  return createPlannedTask(cwd, {
    id,
    title: `task ${id}`,
    goal_id: "2026-01-01-test-goal",
    spec_path: ".sddx/specs/2026-01-01-test-goal.md",
    oracle: { type: "command", run: "t", expect: "exit 0" },
    scope: [],
    assumptions: [],
    depends_on: [],
    ...input,
  });
}

describe("task state", () => {
  test("create + read roundtrip starts in PLANNED with no workspace; a duplicate is refused", () => {
    const cwd = tmpCwd();
    plant(cwd, "T1");
    const back = readTask(cwd, "T1");
    expect(back.phase).toBe("PLANNED");
    expect(isV6Task(back)).toBe(true);
    expect(back.goal_id).toBe("2026-01-01-test-goal");
    expect(back.spec_path).toBe(".sddx/specs/2026-01-01-test-goal.md");
    expect(back.reviews).toEqual([]);
    expect(back.workspace).toBeUndefined();
    expect(isStarted(back)).toBe(false);
    expect(() => plant(cwd, "T1")).toThrow(/exists/);
  });

  test("legal path PLANNED→IN_PROGRESS→IN_REVIEW→IN_PROGRESS→IN_REVIEW→DONE, all in history", () => {
    let t = plant(tmpCwd(), "T1");
    t = transition(t, "IN_PROGRESS");
    t = transition(t, "IN_REVIEW");
    t = transition(t, "IN_PROGRESS", "review failed");
    t = transition(t, "IN_REVIEW");
    t = transition(t, "DONE");
    expect(t.phase).toBe("DONE");
    expect(t.history.map((h) => h.phase)).toEqual([
      "PLANNED",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_PROGRESS",
      "IN_REVIEW",
      "DONE",
    ]);
    expect(t.history[3]?.note).toBe("review failed");
  });

  test("illegal jumps are rejected: DONE is reachable only from IN_REVIEW, terminal states are final", () => {
    const t = plant(tmpCwd(), "T1");
    expect(() => transition(t, "IN_REVIEW")).toThrow(/PLANNED -> IN_REVIEW/);
    expect(() => transition(t, "DONE")).toThrow(/PLANNED -> DONE/);
    transition(t, "IN_PROGRESS");
    expect(() => transition(t, "DONE")).toThrow(/IN_PROGRESS -> DONE/);
    const done = { ...t, phase: "DONE" as const };
    expect(() => transition(done, "IN_PROGRESS")).toThrow(/illegal transition/);
    const abandoned = { ...t, phase: "ABANDONED" as const };
    expect(() => transition(abandoned, "PLANNED")).toThrow(/illegal transition/);
  });

  test("a task file without the v6 schema marker is refused before any transition", () => {
    const t = plant(tmpCwd(), "T1");
    const v5 = { ...t, schema: undefined } as unknown as TaskState;
    expect(() => transition(v5, "IN_PROGRESS")).toThrow(/sddx 5/);
  });

  test("a started task round-trips its workspace branch, base sha and path", () => {
    const cwd = tmpCwd();
    const t = plant(cwd, "T1");
    t.workspace = { branch: "sddx/T1", base_sha: "b".repeat(40), path: ".sddx-worktrees/T1" };
    writeTask(cwd, t);
    const back = readTask(cwd, "T1");
    expect(isStarted(back)).toBe(true);
    expect(back.workspace).toEqual({
      branch: "sddx/T1",
      base_sha: "b".repeat(40),
      path: ".sddx-worktrees/T1",
    });
  });

  test("writeTask bumps updated_at", async () => {
    const cwd = tmpCwd();
    const t = plant(cwd, "T1");
    const before = readTask(cwd, "T1").updated_at;
    await new Promise((r) => setTimeout(r, 5));
    writeTask(cwd, t);
    expect(readTask(cwd, "T1").updated_at > before).toBe(true);
  });
});

describe("scope and depends_on", () => {
  test("scope is copied; a root task omits depends_on", () => {
    const cwd = tmpCwd();
    plant(cwd, "T1", { scope: ["src/api/**"] });
    const back = readTask(cwd, "T1");
    expect(back.scope).toEqual(["src/api/**"]);
    expect(back.depends_on).toBeUndefined();
  });

  test("depends_on records a single parent as a list", () => {
    const cwd = tmpCwd();
    plant(cwd, "T2", { depends_on: ["T1"] });
    expect(readTask(cwd, "T2").depends_on).toEqual(["T1"]);
  });

  test("depends_on records multiple parents (fan-in)", () => {
    const cwd = tmpCwd();
    plant(cwd, "T3", { depends_on: ["T1", "T2"] });
    expect(readTask(cwd, "T3").depends_on).toEqual(["T1", "T2"]);
  });

  test("legacy single-string depends_on on disk reads as a one-element list", () => {
    const cwd = tmpCwd();
    plant(cwd, "T2");
    // the pre-DAG scalar shape
    const legacy = { ...readTask(cwd, "T2"), depends_on: "T1" };
    writeTask(cwd, legacy as never);
    expect(dependsOnList(readTask(cwd, "T2"))).toEqual(["T1"]);
  });

  test("attempt_count defaults to 1 and on_dependency_failure/retry default via helpers", () => {
    const t = plant(tmpCwd(), "T1");
    expect(t.attempt_count).toBe(1);
    expect(t.on_dependency_failure).toBeUndefined();
    expect(t.retry).toBeUndefined();
    expect(failurePolicyOf(t)).toBe("skip");
    expect(retryPolicyOf(t)).toEqual({ max_attempts: 1, workspace: "fresh" });
  });

  test("on_dependency_failure and retry are copied from the spec task", () => {
    const t = plant(tmpCwd(), "T1", {
      on_dependency_failure: "block",
      retry: { max_attempts: 3, workspace: "reuse" },
    });
    expect(t.on_dependency_failure).toBe("block");
    expect(retryPolicyOf(t)).toEqual({ max_attempts: 3, workspace: "reuse" });
  });
});

describe("blockedOn / skippedOn", () => {
  const setPhase = (cwd: string, id: string, phase: TaskState["phase"]) =>
    writeTask(cwd, { ...readTask(cwd, id), phase });

  test("blocked until every named parent is DONE", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    plant(cwd, "B");
    const d = plant(cwd, "D", { depends_on: ["A", "B"] });
    expect(blockedOn(cwd, d)).toBe("A");

    setPhase(cwd, "A", "DONE");
    // A is DONE, B is not: blocked on B specifically, not A
    expect(blockedOn(cwd, d)).toBe("B");

    setPhase(cwd, "B", "DONE");
    expect(blockedOn(cwd, d)).toBeNull();
  });

  test("a missing parent blocks too", () => {
    const cwd = tmpCwd();
    const d = plant(cwd, "D", { depends_on: ["GHOST"] });
    expect(blockedOn(cwd, d)).toBe("GHOST");
  });

  test("block-policy dependent stays blocked when its parent is ABANDONED", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    const b = plant(cwd, "B", { depends_on: ["A"], on_dependency_failure: "block" });
    setPhase(cwd, "A", "ABANDONED");
    expect(blockedOn(cwd, b)).toBe("A");
    expect(skippedOn(cwd, b)).toBeNull();
  });

  test("skip-policy (default) dependent is skipped when its parent is ABANDONED", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    const b = plant(cwd, "B", { depends_on: ["A"] });
    setPhase(cwd, "A", "ABANDONED");
    expect(skippedOn(cwd, b)).toBe("A");
  });

  test("fan-in child skips if any one of several parents is ABANDONED, even if others are DONE", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    plant(cwd, "B");
    const d = plant(cwd, "D", { depends_on: ["A", "B"] });
    setPhase(cwd, "A", "DONE");
    setPhase(cwd, "B", "ABANDONED");
    expect(skippedOn(cwd, d)).toBe("B");
  });

  test("skip cascades transitively through a chain of skip-policy tasks", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    const s1 = plant(cwd, "S1", { depends_on: ["A"] });
    const s2 = plant(cwd, "S2", { depends_on: ["S1"] });
    setPhase(cwd, "A", "ABANDONED");
    expect(skippedOn(cwd, s1)).toBe("A");
    expect(skippedOn(cwd, s2)).toBe("S1");
  });

  test("an unrelated sibling with no shared edge is unaffected", () => {
    const cwd = tmpCwd();
    plant(cwd, "A");
    plant(cwd, "B", { depends_on: ["A"] });
    const r = plant(cwd, "R");
    setPhase(cwd, "A", "ABANDONED");
    expect(blockedOn(cwd, r)).toBeNull();
    expect(skippedOn(cwd, r)).toBeNull();
  });
});

describe("abandonOrRetry", () => {
  test("default policy (max_attempts 1) abandons immediately and records the reason", () => {
    const t = plant(tmpCwd(), "T1");
    const outcome = abandonOrRetry(t, "dead end");
    expect(outcome).toEqual({ retried: false, attempt_count: 1, max_attempts: 1 });
    expect(t.phase).toBe("ABANDONED");
    expect(t.abandon_reason).toBe("dead end");
    expect(t.history.at(-1)).toMatchObject({ phase: "ABANDONED", note: "dead end" });
  });

  test("retries twice before reaching ABANDONED on the third exhaustion", () => {
    const t = plant(tmpCwd(), "T1", { retry: { max_attempts: 3 } });
    // a function, so the compiler does not narrow t.phase across the calls
    const resume = () => {
      t.phase = "IN_PROGRESS";
    };
    resume();

    const first = abandonOrRetry(t, "one");
    expect(first).toEqual({ retried: true, attempt_count: 2, max_attempts: 3 });
    expect(t.phase).toBe("PLANNED");

    resume();
    const second = abandonOrRetry(t, "two");
    expect(second).toEqual({ retried: true, attempt_count: 3, max_attempts: 3 });
    expect(t.phase).toBe("PLANNED");

    resume();
    const third = abandonOrRetry(t, "three");
    expect(third).toEqual({ retried: false, attempt_count: 3, max_attempts: 3 });
    expect(t.phase).toBe("ABANDONED");
  });

  test("a retry clears iterations, verify results, stuck and strict evidence; appends a PLANNED entry", () => {
    const t = plant(tmpCwd(), "T1", { retry: { max_attempts: 2 } });
    const at = new Date().toISOString();
    t.phase = "IN_REVIEW";
    t.iterations = 4;
    t.verified = {
      base_sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      test_files: [],
      red: { exit_code: 1, stdout_sha256: "0".repeat(64), stderr_sha256: "0".repeat(64) },
      green: [],
      at,
    };
    t.last_failure = { half: "green", exit_code: 1, message: "boom", at };
    t.stuck = { fingerprint: "x", count: 3, since: at };
    t.strict = { phase: "RED", runs: [{ test_exit: 1, source: "hook", at }] };
    abandonOrRetry(t, "try again");
    expect(t.iterations).toBe(0);
    expect(t.verified).toBeUndefined();
    expect(t.last_failure).toBeUndefined();
    expect(t.stuck).toBeUndefined();
    expect(t.strict).toBeUndefined();
    expect(t.history.at(-1)).toMatchObject({ phase: "PLANNED", note: "retry after: try again" });
  });

  test("refuses on an already-terminal task", () => {
    const t = plant(tmpCwd(), "T1");
    t.phase = "DONE";
    expect(() => abandonOrRetry(t, "late")).toThrow(/illegal transition/);
  });
});

describe("integration field", () => {
  test("absent by default", () => {
    expect(plant(tmpCwd(), "T1").integration).toBeUndefined();
  });

  test("round-trips a merged record", () => {
    const cwd = tmpCwd();
    const t = plant(cwd, "T1");
    t.integration = {
      run_branch: "sddx/run-2026-01-01-test-goal",
      merge_commit: "a".repeat(40),
      merged_at: new Date().toISOString(),
      result: "merged",
    };
    writeTask(cwd, t);
    const back = readTask(cwd, "T1");
    expect(back.integration?.result).toBe("merged");
    expect(back.integration?.merge_commit).toBe("a".repeat(40));
  });
});

describe("resolveTaskState", () => {
  test("finds a PLANNED task in the main checkout", () => {
    const cwd = tmpCwd();
    plant(cwd, "T1");
    expect(resolveTaskState(cwd, "T1")?.id).toBe("T1");
  });

  test("finds a task in a live worktree directory before the main checkout", () => {
    const cwd = tmpCwd();
    const t = plant(cwd, "T1");
    const wtTasksDir = join(cwd, ".sddx-worktrees", "T1", ".sddx", "tasks");
    mkdirSync(wtTasksDir, { recursive: true });
    writeFileSync(join(wtTasksDir, "T1.json"), JSON.stringify({ ...t, phase: "IN_PROGRESS" }));
    // the worktree copy wins: it is the live one
    expect(resolveTaskState(cwd, "T1")?.phase).toBe("IN_PROGRESS");
  });

  test("falls back to the tip of the task's own branch once no live copy exists", () => {
    const repo = fixtureRepo();
    const g = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    plant(repo, "T1");
    g("switch", "-c", "sddx/T1");
    g("add", "-A");
    g("commit", "-qm", "task commit");
    g("switch", "main");
    // no task file on main or in any worktree directory, only on the branch
    expect(resolveTaskState(repo, "T1")?.id).toBe("T1");
  });

  test("returns null when the task doesn't exist anywhere", () => {
    expect(resolveTaskState(tmpCwd(), "no-such-task")).toBeNull();
  });
});
