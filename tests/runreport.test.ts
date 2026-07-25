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
    expect(rendered).toContain("Run completed");
    expect(rendered).toContain(`Review branch: ${goal.run_branch}`);
    expect(rendered).toContain("Base branch remains unchanged: main");
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
