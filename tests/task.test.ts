import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../src/lib/spec";
import {
  createTask,
  markShipped,
  readTask,
  resolveTaskState,
  taskId,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

const spec = parseSpec(
  "task: Add a Health endpoint!\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n",
).spec!;

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-task-"));
}

describe("taskId", () => {
  test("slugifies and date-prefixes", () => {
    expect(taskId("Add a Health endpoint!", new Date("2026-07-17T00:00:00Z"))).toBe(
      "20260717-add-a-health-endpoint",
    );
  });
});

describe("task state", () => {
  test("create + read roundtrip, starts in PLAN", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
      mode: "branch",
      branch: "sddx/x",
      base_sha: "abc",
    });
    expect(readTask(cwd, t.id).phase).toBe("PLAN");
    expect(() => createTask(cwd, spec, "s", t.workspace)).toThrow(/exists/);
  });

  test("legal path PLAN→RED→GREEN→REFACTOR→VERIFY with evidence", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "abc" });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "REFACTOR");
    t = transition(t, "VERIFY");
    expect(t.phase).toBe("VERIFY");
    expect(t.evidence.red?.test_exit).toBe(1);
    expect(t.evidence.green?.test_exit).toBe(0);
    expect(t.history.map((h) => h.phase)).toEqual(["PLAN", "RED", "GREEN", "REFACTOR", "VERIFY"]);
  });

  test("evidence gates: RED needs failing exit, GREEN needs passing exit", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "RED", { testExit: 0 })).toThrow(/failing test/);
    expect(() => transition(t, "RED")).toThrow(/failing test/);
    t = transition(t, "RED", { testExit: 1 });
    expect(() => transition(t, "GREEN", { testExit: 2 })).toThrow(/passing test/);
  });

  test("illegal jumps and model-claimed DONE are rejected", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "GREEN", { testExit: 0 })).toThrow(/PLAN → GREEN/);
    const v = { ...t, phase: "VERIFY" as const };
    expect(() => transition(v, "DONE")).toThrow(/verifier/);
    expect(transition(v, "DONE", { internal: true }).phase).toBe("DONE");
  });

  test("M1 task files (no workspace.path) still parse; worktree mode records one", () => {
    const cwd = tmpCwd();
    const m1 = createTask(cwd, spec, "s", { mode: "branch", branch: "sddx/x", base_sha: "a" });
    expect(readTask(cwd, m1.id).workspace.path).toBeUndefined();

    const cwd2 = tmpCwd();
    const m2 = createTask(cwd2, spec, "s", {
      mode: "worktree",
      branch: "sddx/y",
      base_sha: "b",
      path: ".sddx-worktrees/y",
    });
    const back = readTask(cwd2, m2.id);
    expect(back.workspace.mode).toBe("worktree");
    expect(back.workspace.path).toBe(".sddx-worktrees/y");
  });

  test("writeTask bumps updated_at", async () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const before = readTask(cwd, t.id).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    writeTask(cwd, t);
    expect(readTask(cwd, t.id).updated_at > before).toBe(true);
  });
});

describe("markShipped", () => {
  test("records goal id, PR url, and a timestamp", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    markShipped(t, "20260719-ship-goal", "https://github.com/org/repo/pull/1");
    expect(t.shipped?.goal_id).toBe("20260719-ship-goal");
    expect(t.shipped?.pr_url).toBe("https://github.com/org/repo/pull/1");
    expect(t.shipped?.at).toBeTruthy();
  });
});

describe("resolveTaskState", () => {
  test("finds a task in the main checkout (branch/none mode)", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(resolveTaskState(cwd, t.id)?.id).toBe(t.id);
  });

  test("finds a task in a live worktree directory before the main checkout", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const wtTasksDir = join(cwd, ".sddx-worktrees", t.id, ".sddx", "tasks");
    mkdirSync(wtTasksDir, { recursive: true });
    writeFileSync(
      join(wtTasksDir, `${t.id}.json`),
      JSON.stringify({ ...t, phase: "GREEN" }, null, 2),
    );
    // worktree copy wins — it's the live one
    expect(resolveTaskState(cwd, t.id)?.phase).toBe("GREEN");
  });

  test("falls back to the tip of the task's own branch once no live copy exists", () => {
    const repo = fixtureRepo();
    const g = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    const t = createTask(repo, spec, "s", { mode: "none", branch: "sddx/x", base_sha: "a" });
    g("switch", "-c", `sddx/${t.id}`);
    g("add", "-A");
    g("commit", "-qm", "task commit");
    g("switch", "main");
    // no task file at all on main or in any worktree dir — only on the branch
    expect(resolveTaskState(repo, t.id)?.id).toBe(t.id);
  });

  test("returns null when the task doesn't exist anywhere", () => {
    expect(resolveTaskState(tmpCwd(), "no-such-task")).toBeNull();
  });
});
