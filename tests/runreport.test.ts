import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { planHash } from "../src/lib/approval";
import { generateRunReport, renderRunReport } from "../src/lib/runreport";
import { fixtureRepo, writeConfig } from "./fixtures";
import {
  completeTask,
  createRun,
  type GoalSpecInput,
  mutateGoal,
  sddx,
  startTask,
} from "./helpers";

// each test drives whole tasks through the CLI, which can exceed the 5s default under load
setDefaultTimeout(60_000);

function abandon(cwd: string, id: string, reason = "dead end"): void {
  startTask(cwd, id);
  const r = sddx(cwd, "task", "abandon", id, "--reason", reason);
  if (r.status !== 0) throw new Error(`abandon ${id}: ${r.stderr}`);
}

/** A started goal whose plan a person approved, or that auto mode authorized. */
function run(cwd: string, mode: "human" | "auto", input: GoalSpecInput) {
  if (mode === "auto") writeConfig(cwd, { interaction_mode: "auto" });
  return createRun(cwd, { ...input, approve: mode === "human" });
}

describe("generateRunReport / renderRunReport", () => {
  test("reports merged/failed/outstanding counts, a diff stat, and review commands", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "human", { tasks: [{ id: "T1" }, { id: "T2" }] });
    completeTask(cwd, "T1");
    abandon(cwd, "T2");

    const report = generateRunReport(cwd, goal.goalId, "main");
    expect(report.merged).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.outstanding).toBe(0);
    expect(report.total).toBe(2);
    expect(report.runBranch).toBe(goal.runBranch);
    expect(report.targetBranch).toBe("main");
    expect(report.diffStat).toContain("T1.done");
    expect(report.reviewCommands).toEqual([
      `git switch ${goal.runBranch}`,
      `git diff main...${goal.runBranch}`,
      `git log --oneline main..${goal.runBranch}`,
    ]);
    expect(report.tasks.find((t) => t.taskId === "T2")).toMatchObject({
      status: "failed",
      state: "ABANDONED",
      attempt: 1,
      reason: "dead end",
    });

    const rendered = renderRunReport(report);
    // one merged, one failed: not "completed", the headline must not
    // contradict the counts printed directly beneath it
    expect(rendered).toContain("Run finished with unresolved tasks");
    expect(rendered).toContain(`Review branch: ${goal.runBranch}`);
    expect(rendered).toContain("Target branch remains unchanged: main");
    expect(rendered).toContain("1 of 2 task(s) merged");
    expect(rendered).toContain("1 task(s) failed");
    expect(rendered).toContain("- T2: failed [ABANDONED, attempt 1: dead end]");
  });

  test("a run with nothing merged yet still reports cleanly", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "human", { tasks: [{ id: "T1" }] });

    const report = generateRunReport(cwd, goal.goalId, "main");
    expect(report.merged).toBe(0);
    expect(report.outstanding).toBe(1);
    expect(report.tasks[0]).toMatchObject({ status: "outstanding", state: "PLANNED", attempt: 1 });
    // the spec was committed before the plan started, so the base already holds
    // it and the run branch differs by nothing: no task work landed
    expect(report.diffStat).toBe("");
    expect(renderRunReport(report)).toContain("0 of 1 task(s) merged");
  });
});

describe("run report completion summary", () => {
  test("names the goal title and the approval line", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "human", { title: "ship the widget", tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    const hash = planHash(join(cwd, goal.specPath)).hash;

    const r = generateRunReport(cwd, goal.goalId, "main");
    expect(r.goal).toBe("ship the widget");
    expect(r.approval?.mode).toBe("human");
    expect(r.approval?.plan_sha256).toBe(hash);
    expect(r.interactionMode).toBe("human");
    expect(r.authorization).toBe("human-approval");

    const out = renderRunReport(r);
    expect(out).toContain("ship the widget");
    expect(out).toContain("- interaction mode: human");
    expect(out).toContain(`- plan: ${hash.slice(0, 12)}`);
  });

  test("reports oracle outcomes and statistics", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "auto", { tasks: [{ id: "T1" }, { id: "T2" }] });
    completeTask(cwd, "T1");
    abandon(cwd, "T2");

    const r = generateRunReport(cwd, goal.goalId, "main");
    expect(r.authorization).toBe("auto");
    expect(r.oracles).toHaveLength(2);
    const alpha = r.oracles.find((o) => o.taskId === "T1");
    expect(alpha?.verdict).toBe("pass");
    expect(alpha?.run).toBe("test -f T1.done");
    expect(r.oracles.find((o) => o.taskId === "T2")?.verdict).toBe("abandoned");

    const out = renderRunReport(r);
    expect(out).toContain("Oracle results");
    expect(out).toContain("- T1: pass, test -f T1.done (expect exit 0)");
  });

  test("records degradation from auto to human", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "human", { tasks: [{ id: "T1" }] });
    mutateGoal(cwd, (g) => {
      const approval = g.approval as Record<string, unknown>;
      approval.requested_mode = "auto";
      approval.degraded_reason = "plan has 9 nodes, over the auto_max_tasks ceiling of 6";
    });
    const out = renderRunReport(generateRunReport(cwd, goal.goalId, "main"));
    expect(out).toContain("requested auto, ran as human");
    expect(out).toContain("auto_max_tasks");
  });

  test("surfaces assumptions recorded during the run", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "auto", {
      assumptions: ["the project uses Vite"],
      tasks: [{ id: "T1" }],
    });

    const r = generateRunReport(cwd, goal.goalId, "main");
    expect(r.assumptions).toContain("the project uses Vite");
    expect(renderRunReport(r)).toContain("the project uses Vite");
  });

  test("both modes render identical sections in identical order", () => {
    const sectionsFor = (mode: "human" | "auto") => {
      const cwd = fixtureRepo();
      const goal = run(cwd, mode, { tasks: [{ id: "T1" }] });
      completeTask(cwd, "T1");
      return renderRunReport(generateRunReport(cwd, goal.goalId, "main"))
        .split("\n")
        .filter((l) => /^[A-Z][A-Za-z ]+$/.test(l.trim()) && !l.startsWith("-"));
    };
    expect(sectionsFor("human")).toEqual(sectionsFor("auto"));
  });

  test("a partially-completed goal still reports branch, counts, and approval", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "auto", { tasks: [{ id: "T1" }, { id: "T2" }] });
    completeTask(cwd, "T1");

    const out = renderRunReport(generateRunReport(cwd, goal.goalId, "main"));
    expect(out).toContain("Run in progress");
    expect(out).toContain(goal.runBranch);
    expect(out).toContain("1 of 2");
    expect(out).toContain("- interaction mode: auto");
  });

  test("a goal with no approval block renders without an approval line", () => {
    const cwd = fixtureRepo();
    const goal = run(cwd, "human", { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    mutateGoal(cwd, (g) => {
      delete g.approval;
    });
    const r = generateRunReport(cwd, goal.goalId, "main");
    expect(r.approval).toBeUndefined();
    expect(r.interactionMode).toBeNull();
    expect(r.authorization).toBeNull();
    expect(renderRunReport(r)).not.toContain("Approval");
  });
});
