import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headBranch, resolveTask, workspaceRoot } from "../src/lib/resolve";
import {
  createPlannedTask,
  readTask,
  type TaskState,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo } from "./fixtures";
import { createRun, startTask } from "./helpers";

function planned(repo: string, id: string): TaskState {
  return createPlannedTask(repo, {
    id,
    title: "demo task",
    goal_id: "2026-01-01-test-goal",
    spec_path: ".sddx/specs/2026-01-01-test-goal.md",
    oracle: { type: "command", run: "true", expect: "exit 0" },
    scope: [],
    assumptions: [],
    depends_on: [],
  });
}

/** A started task whose state sits in `repo`'s own .sddx, as a branch checkout would hold it. */
function started(repo: string, id: string): TaskState {
  const t = planned(repo, id);
  t.workspace = { branch: `sddx/${id}`, base_sha: "0".repeat(40), path: "." };
  transition(t, "IN_PROGRESS");
  writeTask(repo, t);
  return t;
}

describe("workspaceRoot", () => {
  test("finds repo root from nested nonexistent file path", () => {
    const repo = fixtureRepo();
    expect(workspaceRoot(join(repo, "src", "deep", "new.ts"))).toBe(repo);
  });

  test("null outside any repo", () => {
    expect(workspaceRoot("/no/such/path/anywhere")).toBeNull();
  });
});

describe("resolveTask", () => {
  test("none when repo has no .sddx", () => {
    const repo = fixtureRepo();
    expect(resolveTask(join(repo, "src", "a.ts")).kind).toBe("none");
  });

  test("sole started, non-terminal task in the checkout", () => {
    const repo = fixtureRepo();
    started(repo, "T1");
    const res = resolveTask(join(repo, "src", "a.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") {
      expect(res.task.id).toBe("T1");
      expect(res.root).toBe(repo);
    }
  });

  test("a PLANNED task has no worktree, so it governs nothing", () => {
    const repo = fixtureRepo();
    planned(repo, "T1");
    expect(resolveTask(join(repo, "a.ts")).kind).toBe("none");
  });

  test("terminal tasks are not candidates", () => {
    const repo = fixtureRepo();
    started(repo, "T1");
    const t = readTask(repo, "T1");
    transition(t, "ABANDONED");
    writeTask(repo, t);
    expect(resolveTask(join(repo, "a.ts")).kind).toBe("none");
  });

  test("two started, non-terminal tasks → ambiguous with both ids", () => {
    const repo = fixtureRepo();
    started(repo, "T1");
    started(repo, "T2");
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.ids).toEqual(["T1", "T2"]);
  });

  test("corrupt task file reported", () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, ".sddx", "tasks"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "tasks", "BAD.json"), "{nope");
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("corrupt");
    if (res.kind === "corrupt") expect(res.path).toContain("BAD.json");
  });

  test("worktree resolves by directory name, reading the worktree's own .sddx", () => {
    const repo = fixtureRepo();
    createRun(repo, { tasks: [{ id: "T1" }, { id: "T2" }] });
    const wt = startTask(repo, "T1");
    // a second started task elsewhere must not make the worktree ambiguous
    startTask(repo, "T2");
    const res = resolveTask(join(wt, "src", "impl.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") {
      expect(res.task.id).toBe("T1");
      expect(res.task.phase).toBe("IN_PROGRESS");
      expect(res.root).toBe(wt);
    }
  });

  test("branch checkout resolves via sddx/<id> HEAD ref", () => {
    const repo = fixtureRepo();
    started(repo, "T1");
    // a second task would make the scan ambiguous: the branch must disambiguate
    started(repo, "T2");
    spawnSync("git", ["switch", "-qc", "sddx/T1"], { cwd: repo });
    expect(headBranch(repo)).toBe("sddx/T1");
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") expect(res.task.id).toBe("T1");
  });
});
