import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planHash } from "../src/lib/approval";
import { approvalGate } from "../src/lib/approvalgate";
import { fixtureClone, writeConfig } from "./fixtures";
import {
  commitSpec,
  completeTask,
  goalIds,
  goalSpec,
  readGoalAnywhere,
  sddx,
  writeSpec,
} from "./helpers";

const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

// Mode is config-only by design (config.ts interactionMode): the environment is
// part of the command line the agent composes, so it must not switch the gate.
type Mode = "human" | "auto";
function withMode(cwd: string, mode: Mode, autoMaxTasks?: number): void {
  writeConfig(cwd, {
    interaction_mode: mode,
    ...(autoMaxTasks ? { auto_max_tasks: autoMaxTasks } : {}),
  });
}

/**
 * A plan of independent tasks whose oracles pass once each task writes its own
 * file, so the full start, verify, review cycle can be driven without a subagent.
 */
function planRepo(cwd: string, tasks = 2): string {
  return writeSpec(
    cwd,
    "2026-01-01-ship-the-widget",
    goalSpec({
      title: "ship the widget",
      assumptions: ["the project uses Vite"],
      tasks: Array.from({ length: tasks }, (_, i) => ({ id: `n${i}`, title: `build part ${i}` })),
    }),
  );
}

function materialized(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  return {
    goals: goalIds(cwd),
    branches: g(cwd, "branch", "--list", "sddx/*"),
    worktrees: dir(".sddx-worktrees"),
  };
}

const NOTHING = { goals: [], branches: "", worktrees: [] };

function start(cwd: string, rel: string): { goalId: string; taskIds: string[] } {
  const r = sddx(cwd, "plan", "start", rel, "--output", "json");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout).data;
}

const receipt = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("human mode end-to-end", () => {
  test("blocks the whole run before approval, then completes with matching provenance", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);

    // 1. nothing exists, and the gate refuses to start anything
    const blocked = sddx(cwd, "plan", "start", rel);
    expect(blocked.status).toBe(3);
    expect(materialized(cwd)).toEqual(NOTHING);

    // 2. the plan renders without side effects
    expect(sddx(cwd, "plan", "check", rel).status).toBe(0);
    expect(materialized(cwd)).toEqual(NOTHING);

    // 3. approve, then start
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    const { goalId, taskIds } = start(cwd, rel);

    // 4. drive both tasks to DONE
    const receipts = taskIds.map((id) => completeTask(cwd, id).receiptPath);

    // 5. every receipt agrees with the goal on mode and plan hash
    const goal = readGoalAnywhere(cwd, goalId) as {
      approval: { mode: string; plan_sha256: string };
    };
    expect(goal.approval.mode).toBe("human");
    expect(goal.approval.plan_sha256).toBe(planHash(join(cwd, rel)).hash);
    for (const path of receipts) {
      const r = receipt(path);
      expect(r.version).toBe(5);
      expect(r.approval.mode).toBe("human");
      expect(r.approval.plan_sha256).toBe(goal.approval.plan_sha256);
      // the goal-level assumption reached every receipt: a receipt that needs
      // the spec to be interpreted stops being a receipt
      expect(r.approval.assumptions).toContain("the project uses Vite");
    }

    // 6. the summary reports it, and the audit is clean
    const report = sddx(cwd, "run", "report", "--goal", goalId);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("ship the widget");
    expect(report.stdout).toContain("mode: human");
    expect(report.stdout).toContain("2 of 2");
    expect(sddx(cwd, "audit").status).toBe(0);
  }, 60_000);

  test("an interrupted run resumes with no second approval", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    sddx(cwd, "plan", "approve", rel);
    const { goalId, taskIds } = start(cwd, rel);
    const [first, second] = taskIds as [string, string];

    // one task lands; the "session dies" here
    completeTask(cwd, first);

    // resuming reads the board and finds the remaining task ready; no gate,
    // because the gate is armed on plan start only and that already happened
    expect(sddx(cwd, "board", "--output", "json").status).toBe(0);
    completeTask(cwd, second);

    const report = sddx(cwd, "run", "report", "--goal", goalId);
    expect(report.stdout).toContain("2 of 2");
    expect(report.stdout).toContain("Run completed");
    expect(readdirSync(join(cwd, ".sddx", "approvals"))).toHaveLength(1);
  }, 60_000);

  test("editing a task after approval blocks the start with a hash mismatch", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    sddx(cwd, "plan", "approve", rel);

    const path = join(cwd, rel);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"test -f n1.done"');
    writeFileSync(path, text.replace('"test -f n1.done"', '"test -f n1.done || true"'));
    commitSpec(cwd, rel);

    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no approval");
    expect(materialized(cwd)).toEqual(NOTHING);
  }, 30_000);
});

describe("auto mode end-to-end", () => {
  test("completes the same goal unattended with mode auto in every receipt", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    withMode(cwd, "auto");

    // no approval step at all
    const { goalId, taskIds } = start(cwd, rel);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);

    for (const id of taskIds) {
      expect(receipt(completeTask(cwd, id).receiptPath).approval.mode).toBe("auto");
    }
    const report = sddx(cwd, "run", "report", "--goal", goalId);
    expect(report.stdout).toContain("mode: auto");
    expect(report.stdout).toContain("2 of 2");
    expect(sddx(cwd, "audit").status).toBe(0);
  }, 60_000);

  test("exceeding auto_max_tasks refuses terminally and cannot be approved away", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "auto", 2);

    const refused = sddx(cwd, "plan", "start", rel);
    expect(refused.status).not.toBe(0);
    // exit 3 is "approval required"; a bound refuses rather than arming the gate
    expect(refused.status).not.toBe(3);
    expect(refused.stderr).toContain("auto_max_tasks");
    expect(materialized(cwd)).toEqual(NOTHING);

    // No token can buy the run: approving is a human act, so it belongs to
    // human mode. Previously this path produced a run recorded `auto` that a
    // human had in fact approved, the hybrid this behavior removes.
    expect(sddx(cwd, "plan", "approve", rel).status).not.toBe(0);
    expect(sddx(cwd, "plan", "start", rel).status).not.toBe(0);
    expect(materialized(cwd)).toEqual(NOTHING);
  }, 60_000);

  test("the same plan runs once configuration selects human mode", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "human", 2);
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    const { goalId } = start(cwd, rel);
    const goal = readGoalAnywhere(cwd, goalId) as { approval: Record<string, unknown> };
    expect(goal.approval.mode).toBe("human");
    expect(goal.approval.requested_mode).toBeUndefined();
    expect(goal.approval.degraded_reason).toBeUndefined();
  }, 60_000);

  test("the completion summary has identical sections in both modes", () => {
    const sections = (mode: Mode) => {
      const { clone: cwd } = fixtureClone();
      const rel = planRepo(cwd, 1);
      withMode(cwd, mode);
      if (mode === "human") sddx(cwd, "plan", "approve", rel);
      const { goalId, taskIds } = start(cwd, rel);
      completeTask(cwd, taskIds[0] as string);
      return sddx(cwd, "run", "report", "--goal", goalId)
        .stdout.split("\n")
        .filter((l) =>
          /^(Goal|Approval|Summary|Oracle results|Assumptions|Review commands):?$/.test(
            l.trim().replace(/:.*$/, (m) => (l.startsWith("Goal") ? m : "")),
          ),
        );
    };
    const h = sections("human");
    const a = sections("auto");
    expect(h.length).toBeGreaterThan(0);
    expect(h).toEqual(a);
  }, 90_000);
});

describe("the gate is not self-grantable", () => {
  test("SECURITY: approve+start in one turn still raises the dialog on approve", () => {
    // The defeat this closes: an agent runs `plan approve` (ungated) then
    // `plan start`, which now finds a token and passes, so human mode became a
    // no-op that recorded `mode: human` for work no human saw. The fix is that
    // `plan approve` is itself gated and ALWAYS asks.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    withMode(cwd, "human");

    expect(approvalGate({ command: `sddx plan approve ${rel}`, cwd }).decision).toBe("ask");
    // and the start the agent would chain after it is gated too, until a token exists
    expect(approvalGate({ command: `sddx plan start ${rel}`, cwd }).decision).toBe("ask");
    // both halves of a compound command are inspected
    expect(
      approvalGate({ command: `sddx plan approve ${rel} && sddx plan start ${rel}`, cwd }).decision,
    ).toBe("ask");
  }, 30_000);
});
