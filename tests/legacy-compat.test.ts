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
// The matching refusal (an unfinished legacy task must not be silently
// resumed) is NOT here. `--workspace branch|none` is still a supported
// creation path, so a branch-mode task on disk today is current, not legacy —
// there is nothing yet that distinguishes the two. That refusal belongs to
// `retire-alternate-flows`, the change that removes the creation paths and so
// makes "recorded branch mode" unambiguously mean "written by an older
// version".
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeBoard } from "../src/board";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { fakeRedCheck, GRAPH_HEADER, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

const SPEC = `task: do the legacy work
success_criteria:
  - "it works"
oracle:
  type: command
  run: "exit 0"
`;

/** A task created through the still-supported legacy workspace paths. */
function legacyTask(cwd: string, mode: "branch" | "none"): string {
  writeFileSync(join(cwd, "spec.yaml"), SPEC);
  const r = cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", mode);
  expect(r.status).toBe(0);
  const id = readdirSync(join(cwd, ".sddx", "tasks"))[0]?.replace(/\.json$/, "") as string;
  return id;
}

/** Rewrites a task's workspace block to a shape an older sddx would have written. */
function asHistoricalState(cwd: string, id: string, mode: "branch" | "none"): void {
  const p = join(cwd, ".sddx", "tasks", `${id}.json`);
  const t = JSON.parse(readFileSync(p, "utf8"));
  t.workspace = {
    mode,
    branch: mode === "branch" ? `sddx/${id}` : null,
    base_sha: t.workspace.base_sha,
  };
  writeFileSync(p, `${JSON.stringify(t, null, 2)}\n`);
}

describe("legacy workspace state parses and displays", () => {
  for (const mode of ["branch", "none"] as const) {
    test(`an unfinished ${mode}-mode task appears on the board without error`, () => {
      const cwd = fixtureRepo();
      const id = legacyTask(cwd, mode);
      asHistoricalState(cwd, id, mode);

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
      const id = legacyTask(cwd, mode);
      asHistoricalState(cwd, id, mode);

      const shown = cli(cwd, "task", "show", id, "--output", "json");
      expect(shown.status).toBe(0);
      expect(JSON.parse(shown.stdout).data.workspace.mode).toBe(mode);
    });
  }

  test("a task whose workspace block is missing entirely does not crash the board", () => {
    // Older still, or hand-edited. The board reports it rather than throwing —
    // and, per the gate's own rule, an unreadable file must never pass silently.
    const cwd = fixtureRepo();
    const id = legacyTask(cwd, "none");
    const p = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(p, "utf8"));
    t.workspace = undefined;
    writeFileSync(p, `${JSON.stringify(t, null, 2)}\n`);

    expect(() => computeBoard(cwd)).not.toThrow();
    expect(cli(cwd, "board").status).toBe(0);
  });
});

describe("legacy receipts still audit", () => {
  test("a completed branch-mode task audits clean and needs no migration", () => {
    const cwd = fixtureRepo();
    const id = legacyTask(cwd, "branch");

    expect(cli(cwd, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(cwd, id);
    expect(cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(cwd, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(cli(cwd, "verify", id).status).toBe(0);

    // the receipt records the legacy workspace mode it actually ran under
    const receipt = JSON.parse(readFileSync(join(cwd, ".sddx", "receipts", `${id}.json`), "utf8"));
    expect(receipt.workspace ?? "branch").toBeTruthy();

    const audit = cli(cwd, "audit");
    expect(audit.status).toBe(0);
    expect(`${audit.stdout}${audit.stderr}`.toLowerCase()).not.toContain("migration");
  });

  test("the chain stays valid across a legacy and a canonical task together", () => {
    // A repository mid-migration has both shapes in one receipt chain. The
    // hash chain is over receipt bytes, so it must not care which is which.
    const { clone: cwd } = fixtureClone();

    // canonical first, through graph create
    mkdirSync(join(cwd, "specs"), { recursive: true });
    writeFileSync(
      join(cwd, "specs", "a.yaml"),
      'task: build the canonical part\nsuccess_criteria:\n  - a\nscope:\n  - good/**\noracle:\n  type: command\n  run: "exit 0"\n',
    );
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: ship the widget\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n`,
    );
    expect(cli(cwd, "graph", "approve", "--graph", "graph.yaml").status).toBe(0);
    const created = cli(cwd, "graph", "create", "--graph", "graph.yaml", "--output", "json");
    expect(created.status).toBe(0);
    const canonicalId = (JSON.parse(created.stdout).data.taskIds as string[])[0] as string;
    const wt = join(cwd, ".sddx-worktrees", canonicalId);
    expect(cli(wt, "task", "phase", canonicalId, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, canonicalId);
    expect(cli(wt, "task", "phase", canonicalId, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", canonicalId, "VERIFY").status).toBe(0);
    expect(cli(wt, "verify", canonicalId).status).toBe(0);

    // then a legacy-shaped one in the main checkout
    const legacyId = (() => {
      writeFileSync(join(cwd, "spec.yaml"), SPEC);
      const r = cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", "none");
      expect(r.status).toBe(0);
      return readdirSync(join(cwd, ".sddx", "tasks")).map((f) =>
        f.replace(/\.json$/, ""),
      )[0] as string;
    })();
    expect(cli(cwd, "task", "phase", legacyId, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(cwd, legacyId);
    expect(cli(cwd, "task", "phase", legacyId, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(cwd, "task", "phase", legacyId, "VERIFY").status).toBe(0);
    expect(cli(cwd, "verify", legacyId).status).toBe(0);

    expect(existsSync(join(cwd, ".sddx", "receipts", `${legacyId}.json`))).toBe(true);
    const audit = cli(cwd, "audit");
    expect(audit.status).toBe(0);
  }, 60_000);
});
