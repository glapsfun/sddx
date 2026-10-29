import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/lib/receipt";
import { fixtureClone, writeConfig } from "./fixtures";
import { commitSpec, completeTask, goalSpec, readGoalAnywhere, sddx, writeSpec } from "./helpers";

const SPEC_NAME = "2026-01-01-ship-the-widget";
const TASK_IDS = ["P0", "P1"];

/** A two-root plan; each task also carries an assumption of its own, so the
 * receipt shows goal-level and task-level assumptions merged. */
function planRepo(cwd: string, mode: "human" | "auto"): string {
  writeConfig(cwd, { interaction_mode: mode, auto_max_tasks: 9 });
  return writeSpec(
    cwd,
    SPEC_NAME,
    goalSpec({
      title: "ship the widget",
      assumptions: ["the project uses Vite"],
      tasks: TASK_IDS.map((id) => ({ id, extra: 'assumptions: ["the store is postgres"]' })),
    }),
  );
}

/** Runs a whole goal in `mode`, returning its ids and the paths that matter. */
function runGoal(mode: "human" | "auto") {
  const { clone: cwd } = fixtureClone();
  const rel = planRepo(cwd, mode);
  if (mode === "human") expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
  const started = sddx(cwd, "plan", "start", rel, "--output", "json");
  expect(started.status).toBe(0);
  const data = JSON.parse(started.stdout).data;
  for (const id of TASK_IDS) completeTask(cwd, id);
  return { cwd, rel, goalId: data.goalId as string };
}

interface GoalShape {
  approval: {
    mode: string;
    authorization: string;
    plan_sha256: string;
    at: string;
  };
  task_ids: string[];
  merges: { result: string }[];
  run_branch: string;
}

const goalOf = (cwd: string, goalId: string) =>
  readGoalAnywhere(cwd, goalId) as unknown as GoalShape;

const approvalOf = (cwd: string, goalId: string) => goalOf(cwd, goalId).approval;

const receiptOf = (cwd: string, id: string) =>
  JSON.parse(
    readFileSync(join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`), "utf8"),
  );

describe("goal-record provenance", () => {
  test("a human run records mode, plan digest, authorization type and timestamp", () => {
    const { cwd, goalId, rel } = runGoal("human");
    const a = approvalOf(cwd, goalId);
    expect(a.mode).toBe("human");
    expect(a.authorization).toBe("human-approval");
    // the digest is over the spec as reviewed, every byte of it
    expect(a.plan_sha256).toBe(sha256(readFileSync(join(cwd, rel))));
    expect(Date.parse(a.at)).not.toBeNaN();
  });

  test("an auto run records the authorization as auto, not as a human approval", () => {
    const { cwd, goalId } = runGoal("auto");
    const a = approvalOf(cwd, goalId);
    expect(a.mode).toBe("auto");
    expect(a.authorization).toBe("auto");
  }, 60_000);
});

describe("receipt provenance", () => {
  test("a completed run is interpretable with no access to the conversation", () => {
    const { cwd } = runGoal("human");
    for (const id of TASK_IDS) {
      const r = receiptOf(cwd, id);
      // what ran, under what interpretation, authorized how, against which plan
      expect(r.approval.mode).toBe("human");
      expect(r.approval.authorization).toBe("human-approval");
      expect(r.approval.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.approval.assumptions).toEqual(["the project uses Vite", "the store is postgres"]);
      expect(r.oracle.run).toContain("test -f");
      expect(r.runs.length).toBeGreaterThan(0);
    }
  });

  test("an auto receipt carries the auto authorization", () => {
    const { cwd } = runGoal("auto");
    for (const id of TASK_IDS) {
      expect(receiptOf(cwd, id).approval.authorization).toBe("auto");
    }
  }, 60_000);

  test("the audit accepts the added provenance field", () => {
    const { cwd } = runGoal("human");
    for (const id of TASK_IDS) {
      expect(sddx(join(cwd, ".sddx-worktrees", id), "audit").status).toBe(0);
    }
  });
});

describe("the run summary reports provenance", () => {
  test("terminal, JSON and Markdown all carry mode, authorization and assumptions", () => {
    const { cwd, goalId } = runGoal("human");

    const term = sddx(cwd, "run", "report", "--goal", goalId);
    expect(term.status).toBe(0);
    expect(term.stdout).toContain("mode: human");
    expect(term.stdout).toContain("the project uses Vite");
    expect(term.stdout).toContain("the store is postgres");

    const json = sddx(cwd, "run", "report", "--goal", goalId, "--output", "json");
    const d = JSON.parse(json.stdout).data;
    expect(d.interactionMode).toBe("human");
    expect(d.authorization).toBe("human-approval");
    expect(d.assumptions).toContain("the project uses Vite");

    const md = sddx(cwd, "run", "report", "--goal", goalId, "--output", "markdown");
    expect(md.stdout).toContain("the project uses Vite");
  });
});

describe("the two modes differ only in provenance", () => {
  test("git and state topology are identical after authorization", () => {
    const human = runGoal("human");
    const auto = runGoal("auto");

    const shape = (r: ReturnType<typeof runGoal>) => {
      const g = goalOf(r.cwd, r.goalId);
      const branches = spawnSync("git", ["branch", "--list"], { cwd: r.cwd, encoding: "utf8" });
      return {
        taskCount: g.task_ids.length,
        merges: g.merges.map((m) => m.result),
        runBranchShape: g.run_branch.replace(/run-.*/, "run-<id>"),
        branchCount: (branches.stdout ?? "").trim().split("\n").length,
        receiptVersions: TASK_IDS.map((id) => receiptOf(r.cwd, id).version),
        phases: TASK_IDS.map(
          (id) =>
            JSON.parse(
              readFileSync(
                join(r.cwd, ".sddx-worktrees", id, ".sddx", "tasks", `${id}.json`),
                "utf8",
              ),
            ).phase,
        ),
      };
    };
    expect(shape(auto)).toEqual(shape(human));

    // ...and the provenance is exactly where they differ
    const hp = approvalOf(human.cwd, human.goalId);
    const ap = approvalOf(auto.cwd, auto.goalId);
    expect(hp.mode).not.toBe(ap.mode);
    expect(hp.authorization).not.toBe(ap.authorization);
  }, 120_000);

  test("both modes reach the identical goal-scoped Next Actions menu", () => {
    const human = runGoal("human");
    const auto = runGoal("auto");
    const menu = (r: ReturnType<typeof runGoal>) => {
      const out = sddx(r.cwd, "next-actions", "--goal", r.goalId, "--output", "json");
      expect(out.status).toBe(0);
      return JSON.parse(out.stdout).data.nextActions as string[];
    };
    const humanMenu = menu(human);
    expect(humanMenu.length).toBeGreaterThan(0);
    expect(menu(auto)).toEqual(humanMenu);
  }, 120_000);
});

describe("plan-only approval", () => {
  test("an approval recorded without starting is found by a later run", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, "human");

    // plan only: check and approve, start nothing
    expect(sddx(cwd, "plan", "check", rel).status).toBe(0);
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);

    // later, against the unchanged spec, the token still matches
    const started = sddx(cwd, "plan", "start", rel, "--output", "json");
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout).data.goalId).toBeTruthy();
  });

  test("but not once the spec has changed underneath it", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, "human");
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    writeFileSync(
      join(cwd, rel),
      readFileSync(join(cwd, rel), "utf8").replace("postgres", "sqlite"),
    );
    commitSpec(cwd, rel);
    expect(sddx(cwd, "plan", "start", rel).status).toBe(3);
  });
});
