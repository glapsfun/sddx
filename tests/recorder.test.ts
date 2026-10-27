import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchTestRunner, recordTestRun } from "../src/lib/recorder";
import { stopGate } from "../src/lib/stopgate";
import { readTask, writeTask } from "../src/lib/task";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, sddx, startTask } from "./helpers";

/** T1 started in a repository on `profile`, returning its worktree. */
function startedTask(profile: "default" | "strict" = "strict"): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  writeConfig(cwd, { interaction_mode: "human", profile });
  createRun(cwd, { tasks: [{ id: "T1" }] });
  return { cwd, wt: startTask(cwd, "T1") };
}

describe("matchTestRunner", () => {
  test("recognizes known runners, ignores lookalikes", () => {
    expect(matchTestRunner("bun test tests/x.test.ts")).toBe("bun test");
    expect(matchTestRunner("  pytest -k api ")).toBe("pytest");
    expect(matchTestRunner("go test ./...")).toBe("go test");
    expect(matchTestRunner("bun tests/x.ts")).toBeNull();
    expect(matchTestRunner("ls -la")).toBeNull();
    expect(matchTestRunner("echo bun test")).toBeNull();
  });
});

describe("recordTestRun", () => {
  test("no failing test yet + failing run → RED with hook-sourced evidence", () => {
    const { wt } = startedTask();
    const res = recordTestRun(wt, "bun test", 1);
    expect(res).toEqual({ matched: true, recorded: "RED", taskId: "T1" });
    const after = readTask(wt, "T1");
    expect(after.phase).toBe("IN_PROGRESS");
    expect(after.strict?.phase).toBe("RED");
    expect(after.strict?.runs).toEqual([expect.objectContaining({ test_exit: 1, source: "hook" })]);
  });

  test("RED + passing run → GREEN", () => {
    const { wt } = startedTask();
    recordTestRun(wt, "bun test", 1);
    const res = recordTestRun(wt, "bun test", 0);
    expect(res.recorded).toBe("GREEN");
    const after = readTask(wt, "T1");
    expect(after.strict?.phase).toBe("GREEN");
    expect(after.strict?.runs.at(-1)).toMatchObject({ test_exit: 0, source: "hook" });
  });

  test("a passing run before any failure records the observation, no phase", () => {
    const { wt } = startedTask();
    const res = recordTestRun(wt, "bun test", 0);
    expect(res.recorded).toBeNull();
    const after = readTask(wt, "T1");
    expect(after.strict?.phase).toBeUndefined();
    expect(after.strict?.runs).toEqual([expect.objectContaining({ test_exit: 0, source: "hook" })]);
  });

  test("unrelated command leaves the task untouched", () => {
    const { wt } = startedTask();
    const before = JSON.stringify(readTask(wt, "T1"));
    const res = recordTestRun(wt, "ls -la", 0);
    expect(res.matched).toBe(false);
    expect(JSON.stringify(readTask(wt, "T1"))).toBe(before);
  });

  test("missing exit code is never guessed", () => {
    const { wt } = startedTask();
    expect(recordTestRun(wt, "bun test", undefined).matched).toBe(false);
  });
});

describe("stopGate", () => {
  test("non-terminal task blocks with next step", () => {
    const { wt } = startedTask("default");
    const d = stopGate({ cwd: wt });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("T1");
    expect(d.reason).toContain("IN_PROGRESS");
    expect(d.reason).toContain("sddx verify T1");
  });

  test("stop_hook_active always allows", () => {
    const { wt } = startedTask("default");
    expect(stopGate({ cwd: wt, stop_hook_active: true }).block).toBe(false);
  });

  test("no governing task allows", () => {
    const repo = fixtureRepo();
    expect(stopGate({ cwd: repo }).block).toBe(false);
  });

  test("terminal task allows", () => {
    const { cwd, wt } = startedTask("default");
    expect(sddx(cwd, "task", "abandon", "T1", "--reason", "not needed").status).toBe(0);
    // an abandoned task's record lives in the main checkout, not its worktree
    expect(readTask(cwd, "T1").phase).toBe("ABANDONED");
    expect(stopGate({ cwd: wt }).block).toBe(false);
  });

  test("DONE without a receipt blocks — completion is unproven", () => {
    const { wt } = startedTask("default");
    const t = readTask(wt, "T1");
    t.phase = "DONE"; // simulates a crash between the task write and the receipt write
    writeTask(wt, t);
    const d = stopGate({ cwd: wt });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("receipt");
  });
});

describe("the recorder is inert on a legacy task, not throwing", () => {
  test("an unfinished sddx 5 task makes recordTestRun a no-op with no error", () => {
    // The recorder runs from PostToolUse, a hook the user never invoked. A
    // throw here would surface as a generic "sddx hook error" on EVERY observed
    // test run in an upgraded checkout. The migration refusal belongs on the
    // commands a user actually types.
    const repo = fixtureRepo();
    writeConfig(repo, { profile: "strict" });
    const path = join(repo, ".sddx", "tasks", "20260101-legacy.json");
    mkdirSync(join(repo, ".sddx", "tasks"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ id: "20260101-legacy", task: "legacy", phase: "RED", allow: [], history: [] }, null, 2)}\n`,
    );
    // governed by its branch, the way a v5 task resolved
    spawnSync("git", ["switch", "-qc", "sddx/20260101-legacy"], { cwd: repo });
    const before = readFileSync(path, "utf8");

    let res: ReturnType<typeof recordTestRun> | undefined;
    expect(() => {
      res = recordTestRun(repo, "bun test", 1);
    }).not.toThrow();
    expect(res?.matched).toBe(true);
    expect(res?.recorded).toBeNull();
    // and it wrote nothing
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a v6 worktree task still records", () => {
    // the guard must not go so wide that it breaks the ordinary path
    const { wt } = startedTask();
    const res = recordTestRun(wt, "bun test", 1);
    expect(res.matched).toBe(true);
    expect(res.recorded).toBe("RED");
    expect(readTask(wt, "T1").strict?.phase).toBe("RED");
  });
});
