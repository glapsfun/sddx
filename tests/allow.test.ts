import { describe, expect, test } from "bun:test";
import {
  allowPath,
  createPlannedTask,
  readTask,
  type TaskState,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, sddx, startTask } from "./helpers";

const makeTask = (repo: string): TaskState =>
  createPlannedTask(repo, {
    id: "T1",
    title: "allow demo",
    goal_id: "2026-01-01-test-goal",
    spec_path: ".sddx/specs/2026-01-01-test-goal.md",
    oracle: { type: "command", run: "true", expect: "exit 0" },
    scope: [],
    assumptions: [],
    depends_on: [],
  });

/** A strict-profile repository with T1 started, returning its worktree. */
function strictTask(): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
  createRun(cwd, { tasks: [{ id: "T1" }] });
  return { cwd, wt: startTask(cwd, "T1") };
}

describe("allowPath", () => {
  test("appends normalized path, idempotent", () => {
    const t = makeTask(fixtureRepo());
    allowPath(t, "./src/migration.sql");
    allowPath(t, "src/migration.sql");
    expect(t.allow).toEqual(["src/migration.sql"]);
  });

  test("refuses absolute and escaping paths", () => {
    const t = makeTask(fixtureRepo());
    expect(() => allowPath(t, "/etc/passwd")).toThrow("repo-relative");
    expect(() => allowPath(t, "../outside.ts")).toThrow("repo-relative");
  });

  test("refuses terminal tasks", () => {
    const t = makeTask(fixtureRepo());
    transition(t, "ABANDONED");
    expect(() => allowPath(t, "src/a.ts")).toThrow("frozen");
  });
});

describe("sddx task allow (CLI)", () => {
  test("persists to the task file and updates updated_at", () => {
    const { cwd, wt } = strictTask();
    const before = readTask(wt, "T1").updated_at;
    const r = sddx(cwd, "task", "allow", "T1", "src/schema.sql");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("allow=[src/schema.sql]");
    const after = readTask(wt, "T1");
    expect(after.allow).toEqual(["src/schema.sql"]);
    expect(after.updated_at >= before).toBe(true);
  });

  test("fails loudly on a DONE task", () => {
    const { cwd, wt } = strictTask();
    const t = readTask(wt, "T1");
    t.phase = "DONE"; // direct write: IN_PROGRESS→DONE is not a legal transition to walk
    writeTask(wt, t);
    const r = sddx(cwd, "task", "allow", "T1", "src/schema.sql");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("frozen");
  });
});
