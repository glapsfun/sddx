import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createBranchAt } from "../src/lib/git";
import { createGoal, goalId, runBranchName } from "../src/lib/goal";
import { generateRunReport, renderRunReport } from "../src/lib/runreport";
import { parseSpec } from "../src/lib/spec";
import {
  abandonOrRetry,
  createTask,
  readTask,
  taskId,
  transition,
  writeTask,
} from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { createWorktree, resolveBaseRef } from "../src/lib/worktree";
import { fixtureRepo } from "./fixtures";

function registerTask(mainCwd: string, sentence: string): { id: string; wtPath: string } {
  const spec = parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
  ).spec!;
  const id = taskId(spec.task);
  const base = resolveBaseRef(mainCwd);
  const wtPath = createWorktree(mainCwd, id, base.sha);
  createTask(wtPath, spec, ".sddx/specs/x.yaml", {
    mode: "worktree",
    branch: `sddx/${id}`,
    base_sha: base.sha,
    path: relative(mainCwd, wtPath),
  });
  return { id, wtPath };
}

function registerGoal(mainCwd: string, sentence: string, taskIds: string[]) {
  const base = resolveBaseRef(mainCwd);
  const gid = goalId(sentence);
  const runBranch = runBranchName(gid);
  createBranchAt(mainCwd, runBranch, base.sha);
  return createGoal(mainCwd, sentence, taskIds, { id: gid, runBranch, baseSha: base.sha });
}

function completeTask(wtPath: string, id: string, file: string) {
  let t = readTask(wtPath, id);
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(wtPath, t);
  writeFileSync(join(wtPath, file), `${id}\n`);
  const res = verifyTask(wtPath, id, { pluginVersion: "0.0.1" });
  if (res.verdict !== "pass") throw new Error(`fixture task ${id} failed to verify`);
}

function abandonTask(wtPath: string, id: string) {
  const t = readTask(wtPath, id);
  abandonOrRetry(t);
  writeTask(wtPath, t);
}

describe("generateRunReport / renderRunReport", () => {
  test("reports merged/failed/outstanding counts, a diff stat, and review commands", () => {
    const mainCwd = fixtureRepo();
    const merged = registerTask(mainCwd, "Merged for report");
    const failed = registerTask(mainCwd, "Failed for report");
    const goal = registerGoal(mainCwd, "Report run", [merged.id, failed.id]);

    completeTask(merged.wtPath, merged.id, "a.txt");
    abandonTask(failed.wtPath, failed.id);

    const report = generateRunReport(mainCwd, goal.id, "main");
    expect(report.merged).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.outstanding).toBe(0);
    expect(report.total).toBe(2);
    expect(report.runBranch).toBe(goal.run_branch);
    expect(report.targetBranch).toBe("main");
    expect(report.diffStat).toContain("a.txt");
    expect(report.reviewCommands).toEqual([
      `git switch ${goal.run_branch}`,
      `git diff main...${goal.run_branch}`,
      `git log --oneline main..${goal.run_branch}`,
    ]);

    const rendered = renderRunReport(report);
    // one merged, one failed: not "completed" — the headline must not
    // contradict the counts printed directly beneath it
    expect(rendered).toContain("Run finished with unresolved tasks");
    expect(rendered).toContain(`Review branch: ${goal.run_branch}`);
    expect(rendered).toContain("Target branch remains unchanged: main");
    expect(rendered).toContain("1 of 2 task(s) merged");
    expect(rendered).toContain("1 task(s) failed");
  });

  test("a fully partial run (nothing merged) still reports cleanly", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Still running");
    const goal = registerGoal(mainCwd, "Nothing done yet", [t.id]);

    const report = generateRunReport(mainCwd, goal.id, "main");
    expect(report.merged).toBe(0);
    expect(report.outstanding).toBe(1);
    expect(report.diffStat).toBe("");
    expect(renderRunReport(report)).toContain("0 of 1 task(s) merged");
  });
});

/** registerGoal + approval provenance, the way `graph create` writes it. */
function registerApprovedGoal(
  mainCwd: string,
  sentence: string,
  taskIds: string[],
  approval: {
    mode: "human" | "auto";
    requested_mode?: "human" | "auto";
    degraded_reason?: string;
    plan_sha256?: string;
  },
) {
  const base = resolveBaseRef(mainCwd);
  const gid = goalId(sentence);
  const runBranch = runBranchName(gid);
  createBranchAt(mainCwd, runBranch, base.sha);
  return createGoal(mainCwd, sentence, taskIds, {
    id: gid,
    runBranch,
    baseSha: base.sha,
    approval: {
      mode: approval.mode,
      ...(approval.requested_mode ? { requested_mode: approval.requested_mode } : {}),
      ...(approval.degraded_reason ? { degraded_reason: approval.degraded_reason } : {}),
      plan_sha256: approval.plan_sha256 ?? "a".repeat(64),
      at: new Date().toISOString(),
    },
  });
}

describe("run report completion summary", () => {
  test("names the goal sentence and the approval line", () => {
    const cwd = fixtureRepo();
    const { id, wtPath } = registerTask(cwd, "build the widget");
    registerApprovedGoal(cwd, "ship the widget", [id], { mode: "human" });
    completeTask(wtPath, id, "widget.txt");

    const r = generateRunReport(cwd, goalId("ship the widget"), "main");
    expect(r.goal).toBe("ship the widget");
    expect(r.approval?.mode).toBe("human");
    expect(r.approval?.plan_sha256).toBe("a".repeat(64));

    const out = renderRunReport(r);
    expect(out).toContain("ship the widget");
    expect(out).toContain("human");
    expect(out).toContain("a".repeat(64).slice(0, 12));
  });

  test("reports oracle outcomes and statistics", () => {
    const cwd = fixtureRepo();
    const a = registerTask(cwd, "build the alpha part");
    const b = registerTask(cwd, "build the beta part");
    registerApprovedGoal(cwd, "ship both parts", [a.id, b.id], { mode: "auto" });
    completeTask(a.wtPath, a.id, "alpha.txt");
    abandonTask(b.wtPath, b.id);

    const r = generateRunReport(cwd, goalId("ship both parts"), "main");
    expect(r.oracles).toHaveLength(2);
    const alpha = r.oracles.find((o) => o.taskId === a.id);
    expect(alpha?.verdict).toBe("pass");
    expect(alpha?.run).toBe("exit 0");
    expect(r.oracles.find((o) => o.taskId === b.id)?.verdict).toBe("abandoned");

    const out = renderRunReport(r);
    expect(out).toContain("Oracle results");
    expect(out).toContain("pass");
  });

  test("records degradation from auto to human", () => {
    const cwd = fixtureRepo();
    const { id } = registerTask(cwd, "build the widget");
    registerApprovedGoal(cwd, "ship the widget", [id], {
      mode: "human",
      requested_mode: "auto",
      degraded_reason: "plan has 9 nodes, over the auto_max_tasks ceiling of 6",
    });
    const out = renderRunReport(generateRunReport(cwd, goalId("ship the widget"), "main"));
    expect(out).toContain("auto");
    expect(out).toContain("auto_max_tasks");
  });

  test("surfaces assumptions recorded during the run", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      `task: build with assumptions\nsuccess_criteria:\n  - a\nassumptions:\n  - "the project uses Vite"\noracle:\n  type: command\n  run: "exit 0"\n`,
    ).spec!;
    const id = taskId(spec.task);
    const base = resolveBaseRef(cwd);
    const wtPath = createWorktree(cwd, id, base.sha);
    createTask(wtPath, spec, ".sddx/specs/x.yaml", {
      mode: "worktree",
      branch: `sddx/${id}`,
      base_sha: base.sha,
      path: relative(cwd, wtPath),
    });
    registerApprovedGoal(cwd, "ship with assumptions", [id], { mode: "auto" });

    const r = generateRunReport(cwd, goalId("ship with assumptions"), "main");
    expect(r.assumptions).toContain("the project uses Vite");
    expect(renderRunReport(r)).toContain("the project uses Vite");
  });

  test("both modes render identical sections in identical order", () => {
    const sectionsFor = (mode: "human" | "auto") => {
      const cwd = fixtureRepo();
      const { id, wtPath } = registerTask(cwd, "build the widget");
      registerApprovedGoal(cwd, "ship the widget", [id], { mode });
      completeTask(wtPath, id, "widget.txt");
      return renderRunReport(generateRunReport(cwd, goalId("ship the widget"), "main"))
        .split("\n")
        .filter((l) => /^[A-Z][A-Za-z ]+$/.test(l.trim()) && !l.startsWith("-"));
    };
    expect(sectionsFor("human")).toEqual(sectionsFor("auto"));
  });

  test("a partially-completed goal still reports branch, counts, and approval", () => {
    const cwd = fixtureRepo();
    const a = registerTask(cwd, "build the alpha part");
    const b = registerTask(cwd, "build the beta part");
    registerApprovedGoal(cwd, "ship both parts", [a.id, b.id], { mode: "auto" });
    completeTask(a.wtPath, a.id, "alpha.txt");

    const out = renderRunReport(generateRunReport(cwd, goalId("ship both parts"), "main"));
    expect(out).toContain("Run in progress");
    expect(out).toContain(runBranchName(goalId("ship both parts")));
    expect(out).toContain("1 of 2");
    expect(out).toContain("auto");
  });

  test("a goal with no approval block renders without an approval line", () => {
    const cwd = fixtureRepo();
    const { id, wtPath } = registerTask(cwd, "build the widget");
    registerGoal(cwd, "ship the widget", [id]);
    completeTask(wtPath, id, "widget.txt");
    const r = generateRunReport(cwd, goalId("ship the widget"), "main");
    expect(r.approval).toBeUndefined();
    expect(renderRunReport(r)).not.toContain("Approval");
  });
});
