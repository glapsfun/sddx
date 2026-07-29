// Read-only compatibility with state written by earlier versions.
//
// The canonical lifecycle narrows what sddx WRITES — worktree workspaces, goal
// records in refs, typed deferred state. It must not narrow what sddx READS.
// A repository that ran older sddx has task files recording `branch` and
// `none` modes and receipts chained across them, and the commands whose whole
// job is inspection — `board` and `audit` — have to keep working on exactly
// that history. Narrowing the read type together with the write type is a
// defect, not a simplification.
//
// Legacy state is HAND-WRITTEN here, and that is the point. No creation path
// can produce `branch` or `none` any more, so these fixtures are the only way
// such a task can exist — which is exactly what makes the migration refusal
// below expressible. While `--workspace branch|none` was still supported,
// current and legacy state were indistinguishable and refusing would have
// broken working repositories.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeBoard } from "../src/board";
import { sha256 } from "../src/lib/receipt";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { createRun, fakeRedCheck, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const SPEC = `task: do the legacy work
success_criteria:
  - "it works"
oracle:
  type: command
  run: "exit 0"
`;

/**
 * A task file exactly as sddx 3.x would have written it: workspace `branch` or
 * `none`, living in the main checkout, no goal and no run branch. Written by
 * hand because no supported code path produces this shape any more.
 */
function writeLegacyTask(
  cwd: string,
  mode: "branch" | "none",
  opts: { id?: string; phase?: string } = {},
): string {
  const id = opts.id ?? `20240101-legacy-${mode}`;
  const base = git(cwd, "rev-parse", "HEAD").stdout.trim();
  if (mode === "branch") git(cwd, "branch", `sddx/${id}`, base);

  mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
  mkdirSync(join(cwd, ".sddx", "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  writeFileSync(join(cwd, specPath), SPEC);

  const now = "2024-01-01T00:00:00.000Z";
  const state = {
    id,
    task: "do the legacy work",
    phase: opts.phase ?? "PLAN",
    spec_path: specPath,
    oracle: { type: "command", run: "exit 0", expect: "exit 0" },
    workspace: { mode, branch: mode === "branch" ? `sddx/${id}` : null, base_sha: base },
    scope: [],
    allow: [],
    iterations: 0,
    evidence: {},
    history: [{ phase: "PLAN", at: now }],
    created_at: now,
    updated_at: now,
  };
  writeFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), `${JSON.stringify(state, null, 2)}\n`);
  return id;
}

describe("legacy workspace state parses and displays", () => {
  for (const mode of ["branch", "none"] as const) {
    test(`an unfinished ${mode}-mode task appears on the board without error`, () => {
      const cwd = fixtureRepo();
      const id = writeLegacyTask(cwd, mode);

      const board = computeBoard(cwd);
      const row = board.data.tasks.find((t) => t.id === id);
      expect(row).toBeDefined();
      expect(row?.workspace).toBe(mode);
      // not the parse-failure sentinel
      expect(row?.rawPhase).not.toBe("UNREADABLE");

      const r = cli(cwd, "board");
      expect(r.status).toBe(0);
      // `board` writes BOARD.md and prints its path — assert on the artifact
      expect(readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8")).toContain(id);
    });

    test(`a ${mode}-mode task is readable through the CLI's own show path`, () => {
      const cwd = fixtureRepo();
      const id = writeLegacyTask(cwd, mode);

      const shown = cli(cwd, "task", "show", id, "--output", "json");
      expect(shown.status).toBe(0);
      expect(JSON.parse(shown.stdout).data.workspace.mode).toBe(mode);
    });
  }

  test("a task whose workspace block is missing entirely does not crash the board", () => {
    // Older still, or hand-edited. The board reports it rather than throwing —
    // and, per the gate's own rule, an unreadable file must never pass silently.
    const cwd = fixtureRepo();
    const id = writeLegacyTask(cwd, "none");
    const p = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(p, "utf8"));
    t.workspace = undefined;
    writeFileSync(p, `${JSON.stringify(t, null, 2)}\n`);

    expect(() => computeBoard(cwd)).not.toThrow();
    expect(cli(cwd, "board").status).toBe(0);
  });
});

describe("unfinished legacy tasks are not silently resumed", () => {
  for (const mode of ["branch", "none"] as const) {
    test(`advancing an unfinished ${mode}-mode task is refused, naming both remedies`, () => {
      const cwd = fixtureRepo();
      const id = writeLegacyTask(cwd, mode);
      const before = readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8");

      const r = cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
      expect(r.status).not.toBe(0);
      const msg = `${r.stdout}${r.stderr}`;
      // both remedies, by name
      expect(msg).toContain("older sddx");
      expect(msg).toContain("graph create");
      // and it says which mode it found, so the message is actionable
      expect(msg).toContain(mode);

      // the refusal is inert: state is byte-identical
      expect(readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8")).toBe(before);
    });
  }

  test("verify refuses an unfinished legacy task without running its oracle", () => {
    const cwd = fixtureRepo();
    const id = writeLegacyTask(cwd, "branch");
    const before = readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8");

    const r = cli(cwd, "verify", id);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("older sddx");
    // no receipt, and no state change
    expect(existsSync(join(cwd, ".sddx", "receipts", `${id}.json`))).toBe(false);
    expect(readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8")).toBe(before);
  });

  test("a COMPLETED legacy task is untouched — it displays with no migration error", () => {
    // The refusal is scoped to unfinished work. Finished legacy tasks are
    // immutable history and must keep reading normally.
    const cwd = fixtureRepo();
    const id = writeLegacyTask(cwd, "branch", { phase: "DONE" });

    const shown = cli(cwd, "task", "show", id, "--output", "json");
    expect(shown.status).toBe(0);
    expect(`${shown.stdout}${shown.stderr}`.toLowerCase()).not.toContain("older sddx");

    expect(cli(cwd, "board").status).toBe(0);
    const board = computeBoard(cwd);
    expect(board.data.tasks.find((t) => t.id === id)?.rawPhase).not.toBe("UNREADABLE");
  });
});

describe("legacy receipts still audit", () => {
  test("the chain stays valid across a legacy and a canonical task together", () => {
    // A repository mid-migration has both shapes in one receipt chain. The
    // hash chain is over receipt bytes, so it must not care which is which.
    const { clone: cwd } = fixtureClone();

    const { taskIds } = createRun(cwd, cli, "ship the widget", [
      {
        alias: "a",
        spec: 'task: build the canonical part\nsuccess_criteria:\n  - a\nscope:\n  - good/**\noracle:\n  type: command\n  run: "exit 0"\n',
      },
    ]);
    const canonicalId = taskIds[0] as string;
    const wt = join(cwd, ".sddx-worktrees", canonicalId);
    expect(cli(wt, "task", "phase", canonicalId, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, canonicalId);
    expect(cli(wt, "task", "phase", canonicalId, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", canonicalId, "VERIFY").status).toBe(0);
    expect(cli(wt, "verify", canonicalId).status).toBe(0);

    // A legacy receipt chained onto it, the way 3.x left one behind: recording
    // a branch-mode workspace, linked by `prev`, and COMMITTED — audit rejects
    // an uncommitted receipt as unverifiable regardless of its shape, so
    // leaving it loose would have tested the wrong refusal.
    const legacyId = "20240101-legacy-branch";
    // the canonical task's receipt was written inside its own worktree
    const receiptsDir = join(wt, ".sddx", "receipts");
    const canonicalPath = join(receiptsDir, `${canonicalId}.json`);
    const canonical = JSON.parse(readFileSync(canonicalPath, "utf8")) as Record<string, unknown>;
    const legacyReceipt = {
      ...canonical,
      task_id: legacyId,
      workspace: "branch",
      seq: (canonical.seq as number) + 1,
      prev: sha256(readFileSync(canonicalPath)),
    };
    const legacyPath = join(receiptsDir, `${legacyId}.json`);
    writeFileSync(legacyPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`);
    expect(git(wt, "add", "-A").status).toBe(0);
    expect(git(wt, "commit", "-qm", "legacy receipt from 3.x").status).toBe(0);

    expect(existsSync(legacyPath)).toBe(true);
    // audit reads both shapes: the chain verifies clean and no migration is demanded
    const audit = cli(wt, "audit");
    expect(`${audit.stdout}${audit.stderr}`.toLowerCase()).not.toContain("migration");
    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain("chain intact");
  }, 60_000);
});

describe("no creation path can produce legacy workspace state", () => {
  test("every task a run creates records worktree, roots and dependents alike", () => {
    // The write type is narrowed to `worktree`; the read type is not. This
    // asserts the write side across BOTH shapes a run produces — a root task
    // materialized up front, and a dependent that was deferred first.
    const { clone: cwd } = fixtureClone();
    const { taskIds } = createRun(cwd, cli, "prove the write type", [
      {
        alias: "root",
        spec: 'task: the root\nsuccess_criteria:\n  - a\nscope:\n  - "src/root/**"\noracle:\n  type: command\n  run: "exit 0"\n',
      },
      {
        alias: "child",
        spec: 'task: the child\nsuccess_criteria:\n  - a\nscope:\n  - "src/child/**"\noracle:\n  type: command\n  run: "exit 0"\n',
        dependsOn: ["root"],
      },
    ]);
    const [rootId, childId] = taskIds as [string, string];

    const rootState = JSON.parse(
      readFileSync(
        join(cwd, ".sddx-worktrees", rootId, ".sddx", "tasks", `${rootId}.json`),
        "utf8",
      ),
    );
    expect(rootState.workspace.mode).toBe("worktree");

    // the dependent is deferred, and even deferred state names worktree as the
    // mode it will become — `materialize_as` is a write path too
    const childState = JSON.parse(
      readFileSync(join(cwd, ".sddx", "tasks", `${childId}.json`), "utf8"),
    );
    expect(childState.workspace.mode).toBe("deferred");
    expect(childState.workspace.materialize_as).toBe("worktree");

    // drive the root to DONE, then materialize the dependent for real
    const wt = join(cwd, ".sddx-worktrees", rootId);
    expect(cli(wt, "task", "phase", rootId, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, rootId);
    expect(cli(wt, "task", "phase", rootId, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", rootId, "VERIFY").status).toBe(0);
    expect(cli(wt, "verify", rootId).status).toBe(0);
    expect(cli(cwd, "task", "materialize", childId).status).toBe(0);

    const materialized = JSON.parse(
      readFileSync(
        join(cwd, ".sddx-worktrees", childId, ".sddx", "tasks", `${childId}.json`),
        "utf8",
      ),
    );
    expect(materialized.workspace.mode).toBe("worktree");
    expect(materialized.workspace.path).toBe(join(".sddx-worktrees", childId));
  }, 60_000);

  test("the removed creation commands refuse instead of creating anything", () => {
    const cwd = fixtureRepo();
    for (const args of [
      ["task", "create", "--spec", "spec.yaml"],
      ["goal", "create", "--goal", "x", "--tasks", "y"],
    ]) {
      const r = cli(cwd, ...args);
      expect(r.status).not.toBe(0);
      // names the replacement rather than dumping usage
      expect(r.stderr).toContain("graph create");
    }
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
  });
});

describe("the legacy guard covers every path that advances a task", () => {
  /** A 3.x deferred dependent: mode `deferred`, but `materialize_as: "branch"`. */
  function writeLegacyDeferred(cwd: string, parentId: string): string {
    const id = "20240101-legacy-dependent";
    mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
    mkdirSync(join(cwd, ".sddx", "specs"), { recursive: true });
    const specPath = join(".sddx", "specs", `${id}.yaml`);
    writeFileSync(join(cwd, specPath), SPEC);
    const now = "2024-01-01T00:00:00.000Z";
    writeFileSync(
      join(cwd, ".sddx", "tasks", `${id}.json`),
      `${JSON.stringify(
        {
          id,
          task: "do the legacy dependent work",
          phase: "PLAN",
          spec_path: specPath,
          oracle: { type: "command", run: "exit 0", expect: "exit 0" },
          workspace: {
            mode: "deferred",
            materialize_as: "branch",
            branch: null,
            base_sha: `pending:${parentId}`,
          },
          depends_on: [parentId],
          scope: [],
          allow: [],
          iterations: 0,
          evidence: {},
          history: [{ phase: "PLAN", at: now }],
          created_at: now,
          updated_at: now,
        },
        null,
        2,
      )}\n`,
    );
    return id;
  }

  test("materialize refuses a legacy deferred dependent instead of converting it", () => {
    // The one legacy path the mode check alone cannot see: a deferred task's
    // `mode` is "deferred", so the branch it would become lives only in
    // `materialize_as`. Converting it would build exactly the worktree that
    // branch mode existed to avoid.
    const cwd = fixtureRepo();
    const parentId = writeLegacyTask(cwd, "branch", { phase: "DONE" });
    const childId = writeLegacyDeferred(cwd, parentId);

    const r = cli(cwd, "task", "materialize", childId);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("older sddx");
    expect(existsSync(join(cwd, ".sddx-worktrees", childId))).toBe(false);
    // state untouched: still deferred, still naming branch
    const state = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${childId}.json`), "utf8"));
    expect(state.workspace.mode).toBe("deferred");
    expect(state.workspace.materialize_as).toBe("branch");
  });

  test("ABANDONED closes a legacy task out rather than retrying it", () => {
    // Abandoning is the documented way out, so it must work — but it must go
    // TERMINAL, never through the retry branch, which resets to PLAN and wipes
    // the evidence an older sddx would resume from.
    const cwd = fixtureRepo();
    const id = writeLegacyTask(cwd, "branch", { phase: "GREEN" });
    const p = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(p, "utf8"));
    t.retry = { max_attempts: 3, workspace: "fresh" };
    t.attempt_count = 1;
    t.evidence = { red: { test_exit: 1, at: "2024-01-01T00:00:00.000Z" } };
    writeFileSync(p, `${JSON.stringify(t, null, 2)}\n`);

    const r = cli(cwd, "task", "phase", id, "ABANDONED");
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.phase).toBe("ABANDONED");
    // NOT retried: attempts unconsumed and the evidence still there
    expect(after.attempt_count).toBe(1);
    expect(after.evidence.red).toBeDefined();
    expect(`${r.stdout}${r.stderr}`).not.toContain("retry 2/3");
  });
});
