import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_OPTED_IN_LINE } from "../src/lib/hookdispatch";
import { fixtureRepo, writeConfig } from "./fixtures";
import { CLI, completeTask, createRun, doneFile, sddx, startTask } from "./helpers";

function hook(name: string, cwd: string, event: Record<string, unknown> = {}) {
  const r = spawnSync("bun", [CLI, "hook", name], {
    cwd,
    input: JSON.stringify({ cwd, ...event }),
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout || "{}") as {
    decision?: string;
    reason?: string;
    systemMessage?: string;
    hookSpecificOutput?: { additionalContext?: string };
  };
}

describe("session-start", () => {
  test("lists unfinished tasks from the main checkout and from worktrees", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [
        { id: "T1", title: "Started" },
        { id: "T2", title: "Planned" },
      ],
    });
    startTask(cwd, "T1");
    const ctx = hook("session-start", cwd).hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("sddx task T1: IN_PROGRESS, Started");
    expect(ctx).toContain("sddx task T2: PLANNED, Planned");
  });

  test("says only that sddx is available in a repository without sddx state", () => {
    expect(hook("session-start", fixtureRepo()).hookSpecificOutput?.additionalContext).toBe(
      NOT_OPTED_IN_LINE,
    );
  });
});

describe("stop-gate", () => {
  test("blocks stopping while the governing task is IN_PROGRESS", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    const out = hook("stop-gate", wt);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("sddx verify T1");
  });

  test("allows stopping once the task is verified and awaiting review", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const out = hook("stop-gate", wt);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("awaiting review");
  });

  test("allows stopping a stuck task with an escalation note", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    writeConfig(cwd, { interaction_mode: "human", stuck_threshold: 2 });
    const wt = startTask(cwd, "T1");
    sddx(cwd, "verify", "T1");
    sddx(cwd, "verify", "T1");
    const out = hook("stop-gate", wt);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("stuck");
  });

  test("a DONE task with its receipt does not block", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    expect(hook("stop-gate", worktree).decision).toBeUndefined();
  });

  test("the main checkout with only PLANNED tasks does not block", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    expect(hook("stop-gate", cwd)).toEqual({});
  });
});
