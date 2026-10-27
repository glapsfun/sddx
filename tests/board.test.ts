import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardData, renderBoard, writeBoard } from "../src/board";
import {
  createPlannedTask,
  type PlannedTaskInput,
  type TaskState,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

const GOAL = "2026-01-01-board";

function makeTask(repo: string, id: string, input: Partial<PlannedTaskInput> = {}): TaskState {
  return createPlannedTask(repo, {
    id,
    title: "board demo",
    goal_id: GOAL,
    spec_path: `.sddx/specs/${GOAL}.md`,
    oracle: { type: "command", run: "true", expect: "exit 0" },
    scope: [],
    assumptions: [],
    depends_on: [],
    ...input,
  });
}

/** Moves a task along legal transitions and saves it. */
function advance(repo: string, t: TaskState, ...phases: TaskState["phase"][]): TaskState {
  for (const p of phases) transition(t, p);
  writeTask(repo, t);
  return t;
}

describe("renderBoard", () => {
  test("empty state renders deterministically", () => {
    const repo = fixtureRepo();
    const a = renderBoard(repo);
    expect(a).toContain("No tasks registered");
    expect(a).toContain("do not edit");
    expect(renderBoard(repo)).toBe(a);
  });

  test("byte-identical re-render with tasks, receipts, and allow entries", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo, "T1");
    t.allow.push("src/migration.sql");
    writeTask(repo, t);
    makeTask(repo, "T2", { title: "second thing" });
    mkdirSync(join(repo, ".sddx", "receipts"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "receipts", "T1.json"), JSON.stringify({ seq: 3 }, null, 2));
    const a = renderBoard(repo);
    expect(a).toBe(renderBoard(repo));
    expect(a).toContain(
      `| T1 | ${GOAL} | PLANNED | - | board demo | 1 | 0 | #3 | allow: src/migration.sql |`,
    );
    expect(a).toContain(`| T2 | ${GOAL} | PLANNED | - | second thing | 1 | 0 | - | - |`);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps anywhere
  });

  test("dependent row shows its parent and a blocked marker until the parent is DONE", () => {
    const repo = fixtureRepo();
    const parent = makeTask(repo, "T1", { title: "parent task" });
    makeTask(repo, "T2", { title: "child task", depends_on: ["T1"] });

    const blocked = renderBoard(repo);
    expect(blocked).toContain("| Task | Goal | State | Depends |");
    expect(blocked).toContain(`| T2 | ${GOAL} | PLANNED blocked-on-T1 | T1 | child task |`);

    advance(repo, parent, "IN_PROGRESS", "IN_REVIEW", "DONE");
    const unblocked = renderBoard(repo);
    expect(unblocked).not.toContain("blocked-on-");
    expect(unblocked).toContain(`| T2 | ${GOAL} | PLANNED | T1 | child task |`);
  });

  test("worktree task row wins over the main checkout copy and uses worktree receipts", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo, "T1"); // main checkout copy, PLANNED
    const wt = join(repo, ".sddx-worktrees", "T1");
    mkdirSync(join(wt, ".sddx", "tasks"), { recursive: true });
    mkdirSync(join(wt, ".sddx", "receipts"), { recursive: true });
    const live = {
      ...t,
      phase: "IN_PROGRESS",
      workspace: { branch: "sddx/T1", base_sha: "0".repeat(40), path: ".sddx-worktrees/T1" },
    };
    writeFileSync(join(wt, ".sddx", "tasks", "T1.json"), JSON.stringify(live, null, 2));
    writeFileSync(join(wt, ".sddx", "receipts", "T1.json"), JSON.stringify({ seq: 1 }));
    const board = renderBoard(repo);
    expect(board).toContain(`| T1 | ${GOAL} | IN_PROGRESS |`);
    expect(board).toContain("| #1 |");
    expect(board).not.toContain("PLANNED");
  });

  test("corrupt or sddx 5 task files render a flagged row, the board still renders others", () => {
    const repo = fixtureRepo();
    makeTask(repo, "T1");
    writeFileSync(join(repo, ".sddx", "tasks", "BAD.json"), "{broken");
    writeFileSync(
      join(repo, ".sddx", "tasks", "OLD.json"),
      JSON.stringify({ id: "OLD", phase: "RED", task: "v5 task" }),
    );
    const board = renderBoard(repo);
    expect(board).toContain("| BAD | - | UNREADABLE |");
    expect(board).toContain("| OLD | - | UNREADABLE |");
    expect(board).toContain(`| T1 | ${GOAL} | PLANNED |`);
  });
});

describe("state labels", () => {
  test("a mixed goal renders every v6 state with its stuck, blocked and abandon notes", () => {
    const repo = fixtureRepo();

    makeTask(repo, "READY", { title: "ready root" });

    const running = makeTask(repo, "RUN", { title: "running root" });
    advance(repo, running, "IN_PROGRESS");

    const stuck = makeTask(repo, "STUCK", { title: "stuck root" });
    stuck.stuck = { fingerprint: "f", count: 3, since: new Date(0).toISOString() };
    advance(repo, stuck, "IN_PROGRESS");

    const review = makeTask(repo, "REVIEW", { title: "in review" });
    advance(repo, review, "IN_PROGRESS", "IN_REVIEW");

    const failed = makeTask(repo, "FAILED", { title: "failed parent" });
    failed.abandon_reason = "dead end";
    advance(repo, failed, "IN_PROGRESS", "ABANDONED");

    // skip policy (default): `task abandon` marks it ABANDONED with reason "skipped"
    const skipped = makeTask(repo, "SKIPPED", { title: "skipped", depends_on: ["FAILED"] });
    skipped.abandon_reason = "skipped";
    advance(repo, skipped, "ABANDONED");

    // block policy: stays PLANNED and blocked on the same failed parent
    makeTask(repo, "BLOCKED", {
      title: "blocked dependent",
      depends_on: ["FAILED"],
      on_dependency_failure: "block",
    });

    const done = makeTask(repo, "DONE1", { title: "completed root" });
    advance(repo, done, "IN_PROGRESS", "IN_REVIEW", "DONE");

    const data = boardData(repo);
    const row = (id: string) => data.tasks.find((t) => t.id === id);
    expect(row("READY")).toMatchObject({ state: "PLANNED", label: "PLANNED", blockedOnId: null });
    expect(row("RUN")).toMatchObject({ state: "IN_PROGRESS", label: "IN_PROGRESS" });
    expect(row("STUCK")).toMatchObject({
      state: "IN_PROGRESS",
      label: "IN_PROGRESS stuck",
      stuck: true,
    });
    expect(row("REVIEW")).toMatchObject({ state: "IN_REVIEW", label: "IN_REVIEW" });
    expect(row("FAILED")).toMatchObject({ state: "ABANDONED", note: "dead end" });
    expect(row("SKIPPED")).toMatchObject({ state: "ABANDONED", note: "skipped" });
    expect(row("BLOCKED")).toMatchObject({
      state: "PLANNED",
      label: "PLANNED blocked-on-FAILED",
      blockedOnId: "FAILED",
    });
    expect(row("DONE1")).toMatchObject({ state: "DONE", label: "DONE" });

    const rendered = renderBoard(repo);
    expect(rendered).toContain(`| STUCK | ${GOAL} | IN_PROGRESS stuck |`);
    expect(rendered).toContain(`| BLOCKED | ${GOAL} | PLANNED blocked-on-FAILED | FAILED |`);
    expect(rendered).toMatch(/\| FAILED \| [^\n]* \| dead end \|/);
    expect(rendered).toMatch(/\| SKIPPED \| [^|]+ \| ABANDONED \| FAILED \|[^\n]* \| skipped \|/);
  });
});

describe("flagged worktrees", () => {
  const writeSweepState = (repo: string, content: string) => {
    mkdirSync(join(repo, ".sddx"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "sweep.json"), content);
  };

  test("skipped worktrees render as a flagged section, ordered by path", () => {
    const repo = fixtureRepo();
    makeTask(repo, "T1");
    writeSweepState(
      repo,
      JSON.stringify({
        skipped: [
          { path: ".sddx-worktrees/b", reason: "phase IN_PROGRESS" },
          { path: ".sddx-worktrees/a", reason: "dirty" },
        ],
      }),
    );
    const board = renderBoard(repo);
    expect(board).toContain("Flagged worktrees");
    expect(board.indexOf(".sddx-worktrees/a")).toBeLessThan(board.indexOf(".sddx-worktrees/b"));
    expect(board).toContain("dirty");
    expect(board).toContain("phase IN_PROGRESS");
    expect(renderBoard(repo)).toBe(board); // still byte-deterministic
  });

  test("section renders even when no tasks are registered", () => {
    const repo = fixtureRepo();
    writeSweepState(
      repo,
      JSON.stringify({ skipped: [{ path: ".sddx-worktrees/x", reason: "dirty" }] }),
    );
    const board = renderBoard(repo);
    expect(board).toContain("No tasks registered");
    expect(board).toContain("Flagged worktrees");
  });

  test("no section when sweep state is absent or empty", () => {
    const repo = fixtureRepo();
    makeTask(repo, "T1");
    expect(renderBoard(repo)).not.toContain("Flagged worktrees");
    writeSweepState(repo, JSON.stringify({ skipped: [] }));
    expect(renderBoard(repo)).not.toContain("Flagged worktrees");
  });

  test("corrupt sweep state is flagged without breaking the board", () => {
    const repo = fixtureRepo();
    makeTask(repo, "T1");
    writeSweepState(repo, "{broken");
    const board = renderBoard(repo);
    expect(board).toContain("| T1 |");
    expect(board).toContain("Flagged worktrees");
    expect(board).toContain("unreadable");
  });
});

describe("writeBoard", () => {
  test("writes once, then skips unchanged renders", () => {
    const repo = fixtureRepo();
    makeTask(repo, "T1");
    const first = writeBoard(repo);
    expect(first.changed).toBe(true);
    const mtime = statSync(first.path).mtimeMs;
    const second = writeBoard(repo);
    expect(second.changed).toBe(false);
    expect(statSync(first.path).mtimeMs).toBe(mtime);
    expect(readFileSync(first.path, "utf8")).toBe(renderBoard(repo));
  });
});
