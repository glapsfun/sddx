import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchTestRunner, recordTestRun } from "../src/lib/recorder";
import { stopGate } from "../src/lib/stopgate";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

const SPEC = {
  task: "recorder demo",
  context: [],
  success_criteria: ["x"],
  oracle: { type: "command" as const, run: "true", expect: "exit 0" },
  stop_rules: [],
  out_of_scope: [],
  scope: [],
  assumptions: [],
};

const makeTask = (repo: string) =>
  createTask(repo, SPEC, ".sddx/specs/x.yaml", {
    mode: "worktree",
    branch: null,
    base_sha: "0".repeat(40),
  });

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
  test("PLAN + failing run → RED with hook-sourced evidence", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    const res = recordTestRun(repo, "bun test", 1);
    expect(res).toEqual({ matched: true, transitioned: "RED", taskId: t.id });
    const after = readTask(repo, t.id);
    expect(after.phase).toBe("RED");
    expect(after.evidence.red).toMatchObject({ test_exit: 1, source: "hook" });
  });

  test("RED + passing run → GREEN", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    transition(t, "RED", { testExit: 1 });
    writeTask(repo, t);
    const res = recordTestRun(repo, "bun test", 0);
    expect(res.transitioned).toBe("GREEN");
    expect(readTask(repo, t.id).evidence.green).toMatchObject({ test_exit: 0, source: "hook" });
  });

  test("PLAN + passing run records observation, no transition", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    const res = recordTestRun(repo, "bun test", 0);
    expect(res.transitioned).toBeNull();
    const after = readTask(repo, t.id);
    expect(after.phase).toBe("PLAN");
    expect(after.evidence.last_test).toMatchObject({ test_exit: 0, source: "hook" });
  });

  test("unrelated command leaves the task untouched", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    const before = JSON.stringify(readTask(repo, t.id));
    const res = recordTestRun(repo, "ls -la", 0);
    expect(res.matched).toBe(false);
    expect(JSON.stringify(readTask(repo, t.id))).toBe(before);
  });

  test("missing exit code is never guessed", () => {
    const repo = fixtureRepo();
    makeTask(repo);
    expect(recordTestRun(repo, "bun test", undefined).matched).toBe(false);
  });
});

describe("stopGate", () => {
  test("non-terminal task blocks with next step", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    transition(t, "RED", { testExit: 1 });
    writeTask(repo, t);
    const d = stopGate({ cwd: repo });
    expect(d.block).toBe(true);
    expect(d.reason).toContain(t.id);
    expect(d.reason).toContain("RED");
  });

  test("stop_hook_active always allows", () => {
    const repo = fixtureRepo();
    makeTask(repo);
    expect(stopGate({ cwd: repo, stop_hook_active: true }).block).toBe(false);
  });

  test("no governing task allows", () => {
    const repo = fixtureRepo();
    expect(stopGate({ cwd: repo }).block).toBe(false);
  });

  test("terminal task allows", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    transition(t, "ABANDONED");
    writeTask(repo, t);
    expect(stopGate({ cwd: repo }).block).toBe(false);
  });

  test("DONE without a receipt blocks — completion is unproven", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    t.phase = "DONE"; // simulates a verify crash between task write and receipt write
    writeTask(repo, t);
    // terminal tasks are invisible to the workspace scan; identify via branch
    spawnSync("git", ["switch", "-qc", `sddx/${t.id}`], { cwd: repo });
    const d = stopGate({ cwd: repo });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("receipt");
  });
});

describe("the recorder is inert on a legacy task, not throwing", () => {
  test("an unfinished legacy task makes recordTestRun a no-op with no error", () => {
    // The recorder runs from PostToolUse — a hook the user never invoked. If
    // the legacy guard threw here it would surface as a generic "sddx hook
    // error" on EVERY observed test run in an upgraded checkout, and because
    // the throw precedes writeTask it would also silently disable stuck-streak
    // accumulation for that checkout. The migration refusal belongs on the
    // commands a user actually types.
    const repo = fixtureRepo();
    const t = createTask(repo, SPEC, "s", {
      mode: "branch",
      branch: "sddx/legacy",
      base_sha: "abc",
    });
    const before = readFileSync(join(repo, ".sddx", "tasks", `${t.id}.json`), "utf8");

    let res: ReturnType<typeof recordTestRun> | undefined;
    expect(() => {
      res = recordTestRun(repo, "bun test", 1);
    }).not.toThrow();
    expect(res?.matched).toBe(true);
    expect(res?.transitioned).toBeNull();
    // and it wrote nothing — the refusal promises state is unmodified
    expect(readFileSync(join(repo, ".sddx", "tasks", `${t.id}.json`), "utf8")).toBe(before);
  });

  test("a normal worktree task still records and transitions", () => {
    // the guard must not go so wide that it breaks the ordinary path
    const repo = fixtureRepo();
    const t = createTask(repo, SPEC, "s", {
      mode: "worktree",
      branch: "sddx/ok",
      base_sha: "abc",
      path: ".",
    });
    const res = recordTestRun(repo, "bun test", 1);
    expect(res.matched).toBe(true);
    expect(res.transitioned).toBe("RED");
    expect(readTask(repo, t.id).phase).toBe("RED");
  });
});
