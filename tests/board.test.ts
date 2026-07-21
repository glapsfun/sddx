import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBoard, writeBoard } from "../src/board";
import { createTask, transition, writeTask } from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

const SPEC = {
  task: "board demo",
  context: [],
  success_criteria: ["x"],
  oracle: { type: "command" as const, run: "true", expect: "exit 0" },
  stop_rules: [],
  out_of_scope: [],
  scope: [],
};

const makeTask = (repo: string, sentence = "board demo") =>
  createTask(repo, { ...SPEC, task: sentence }, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: "0".repeat(40),
  });

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
    const t = makeTask(repo);
    t.allow.push("src/migration.sql");
    writeTask(repo, t);
    makeTask(repo, "second thing");
    mkdirSync(join(repo, ".sddx", "receipts"), { recursive: true });
    writeFileSync(
      join(repo, ".sddx", "receipts", `${t.id}.json`),
      JSON.stringify({ seq: 3 }, null, 2),
    );
    const a = renderBoard(repo);
    expect(a).toBe(renderBoard(repo));
    expect(a).toContain(`| ${t.id} | PLAN | — | board demo | none | 0 | #3 | src/migration.sql |`);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps anywhere
  });

  test("dependent row shows its parent and a blocked marker until the parent is DONE", () => {
    const repo = fixtureRepo();
    const parent = makeTask(repo, "parent task");
    const child = createTask(
      repo,
      { ...SPEC, task: "child task" },
      ".sddx/specs/c.yaml",
      { mode: "none", branch: null, base_sha: `pending:${parent.id}` },
      { dependsOn: parent.id },
    );

    const blocked = renderBoard(repo);
    expect(blocked).toContain("| Task | Phase | Depends |");
    expect(blocked).toContain(`⏸blocked-on-${parent.id}`);
    // the child names its parent in the Depends column
    expect(blocked).toMatch(new RegExp(`\\| ${child.id} \\|.*\\| ${parent.id} \\|`));

    // once the parent reaches DONE, the child is no longer blocked
    transition(parent, "RED", { testExit: 1 });
    transition(parent, "GREEN", { testExit: 0 });
    transition(parent, "VERIFY");
    transition(parent, "DONE", { internal: true });
    writeTask(repo, parent);
    expect(renderBoard(repo)).not.toContain("blocked-on-");
  });

  test("worktree task row wins over workspace copy and uses worktree receipts", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo); // workspace copy in PLAN
    const wt = join(repo, ".sddx-worktrees", t.id);
    mkdirSync(join(wt, ".sddx", "tasks"), { recursive: true });
    mkdirSync(join(wt, ".sddx", "receipts"), { recursive: true });
    const live = { ...t, phase: "GREEN", workspace: { ...t.workspace, mode: "worktree" } };
    writeFileSync(join(wt, ".sddx", "tasks", `${t.id}.json`), JSON.stringify(live, null, 2));
    writeFileSync(join(wt, ".sddx", "receipts", `${t.id}.json`), JSON.stringify({ seq: 1 }));
    const board = renderBoard(repo);
    expect(board).toContain(`| ${t.id} | GREEN |`);
    expect(board).toContain("| worktree |");
    expect(board).toContain("| #1 |");
    expect(board).not.toContain("| PLAN |");
  });

  test("corrupt task file renders a flagged row, board still renders others", () => {
    const repo = fixtureRepo();
    const ok = makeTask(repo);
    writeFileSync(join(repo, ".sddx", "tasks", "20260101-bad.json"), "{broken");
    const board = renderBoard(repo);
    expect(board).toContain("20260101-bad");
    expect(board).toContain("UNREADABLE");
    expect(board).toContain(ok.id);
  });
});

describe("flagged worktrees", () => {
  const writeSweepState = (repo: string, content: string) => {
    mkdirSync(join(repo, ".sddx"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "sweep.json"), content);
  };

  test("skipped worktrees render as a flagged section, ordered by path", () => {
    const repo = fixtureRepo();
    makeTask(repo);
    writeSweepState(
      repo,
      JSON.stringify({
        skipped: [
          { path: ".sddx-worktrees/b", reason: "phase RED" },
          { path: ".sddx-worktrees/a", reason: "dirty" },
        ],
      }),
    );
    const board = renderBoard(repo);
    expect(board).toContain("Flagged worktrees");
    expect(board.indexOf(".sddx-worktrees/a")).toBeLessThan(board.indexOf(".sddx-worktrees/b"));
    expect(board).toContain("dirty");
    expect(board).toContain("phase RED");
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
    makeTask(repo);
    expect(renderBoard(repo)).not.toContain("Flagged worktrees");
    writeSweepState(repo, JSON.stringify({ skipped: [] }));
    expect(renderBoard(repo)).not.toContain("Flagged worktrees");
  });

  test("corrupt sweep state is flagged without breaking the board", () => {
    const repo = fixtureRepo();
    const ok = makeTask(repo);
    writeSweepState(repo, "{broken");
    const board = renderBoard(repo);
    expect(board).toContain(ok.id);
    expect(board).toContain("Flagged worktrees");
    expect(board).toContain("unreadable");
  });
});

describe("writeBoard", () => {
  test("writes once, then skips unchanged renders", () => {
    const repo = fixtureRepo();
    makeTask(repo);
    const first = writeBoard(repo);
    expect(first.changed).toBe(true);
    const mtime = statSync(first.path).mtimeMs;
    const second = writeBoard(repo);
    expect(second.changed).toBe(false);
    expect(statSync(first.path).mtimeMs).toBe(mtime);
    expect(readFileSync(first.path, "utf8")).toBe(renderBoard(repo));
  });
});
