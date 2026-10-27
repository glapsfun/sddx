import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectRunState, renderMenu, resolveSelection, runActions } from "../src/lib/next-actions";
import { fixtureRepo } from "./fixtures";
import { completeTask, createRun, sddx, startTask } from "./helpers";

// each test drives whole tasks through the CLI, which can exceed the 5s default under load
setDefaultTimeout(60_000);

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function abandon(cwd: string, id: string): void {
  startTask(cwd, id);
  const r = sddx(cwd, "task", "abandon", id, "--reason", "dead end");
  if (r.status !== 0) throw new Error(`abandon ${id}: ${r.stderr}`);
}

describe("detectRunState", () => {
  test("classifies merged, failed, and outstanding tasks", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }, { id: "T3" }] });
    completeTask(cwd, "T1");
    abandon(cwd, "T2");

    const state = detectRunState(cwd, run.goalId);
    expect(state.mergedTaskIds).toEqual(["T1"]);
    expect(state.failedTaskIds).toEqual(["T2"]);
    expect(state.outstandingTaskIds).toEqual(["T3"]);
    expect(state.runBranch).toBe(run.runBranch);
    expect(state.shipped).toBeNull();
  });
});

describe("runActions", () => {
  test("no create-pr/merge-to-target actions until something has merged", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    const actions = runActions(cwd, detectRunState(cwd, run.goalId));
    expect(actions.some((a) => a.id === "create-pr")).toBe(false);
    expect(actions.some((a) => a.id === "merge-to-target")).toBe(false);
    expect(actions.some((a) => a.id === "review")).toBe(true);
    expect(actions.some((a) => a.id === "exit")).toBe(true);
  });

  test("Commit Remaining Changes appears only for real changes, never for sddx's goal record", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    // the user's own artifacts (spec, approval token, config) are committed, so
    // anything left dirty afterwards would come from the run's bookkeeping
    git(cwd, "add", ".sddx/specs", ".sddx/approvals", ".sddx/config.json");
    git(cwd, "commit", "-qm", "plan artifacts");
    completeTask(cwd, "T1");

    // the goal record and its merge log live in a ref, never in the checkout
    expect(existsSync(join(cwd, ".sddx", "goals"))).toBe(false);
    const clean = runActions(cwd, detectRunState(cwd, run.goalId));
    expect(clean.some((a) => a.id === "commit-remaining")).toBe(false);

    writeFileSync(join(cwd, "notes.txt"), "user change\n");
    const dirty = runActions(cwd, detectRunState(cwd, run.goalId));
    expect(dirty.some((a) => a.id === "commit-remaining")).toBe(true);
  });

  test("a merged task unlocks create-pr, merge-to-target, and its own revert action", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");

    const actions = runActions(cwd, detectRunState(cwd, run.goalId));
    expect(actions.some((a) => a.id === "create-pr")).toBe(true);
    expect(actions.some((a) => a.id === "merge-to-target")).toBe(true);
    expect(actions.some((a) => a.id === "revert-T1")).toBe(true);
  });

  test("a failed task offers a retry action naming it", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    abandon(cwd, "T1");

    const actions = runActions(cwd, detectRunState(cwd, run.goalId));
    const retry = actions.find((a) => a.id === "retry-T1");
    expect(retry).toBeDefined();
    expect(retry?.label).toContain("T1");
  });

  test("revert action reverts the task's merge and disappears on re-detection", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    expect(git(cwd, "cat-file", "-e", `${run.runBranch}:T1.done`).status).toBe(0);

    const state = detectRunState(cwd, run.goalId);
    const actions = runActions(cwd, state);
    const resolved = resolveSelection("revert T1", actions);
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error("unreachable");
    const result = resolved.run?.(cwd, { branch: state.runBranch });
    expect(result?.ok).toBe(true);

    const after = detectRunState(cwd, run.goalId);
    expect(after.mergedTaskIds).toEqual([]);
    expect(runActions(cwd, after).some((a) => a.id === "revert-T1")).toBe(false);
    expect(git(cwd, "cat-file", "-e", `${run.runBranch}:T1.done`).status).not.toBe(0);
  });

  test("menu renders and numeric selection matches natural-language selection", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");

    const actions = runActions(cwd, detectRunState(cwd, run.goalId));
    const menu = renderMenu(actions);
    expect(menu).toContain("Next Actions");
    expect(menu).toContain("Review Changes");

    const byNumber = resolveSelection("1", actions);
    const byName = resolveSelection("review changes", actions);
    expect("error" in byNumber).toBe(false);
    expect("error" in byName).toBe(false);
    if ("error" in byNumber || "error" in byName) throw new Error("unreachable");
    expect(byNumber.id).toBe(byName.id);
  });
});
