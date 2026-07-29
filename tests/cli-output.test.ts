import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "./fixtures";
import { createRun, fakeRedCheck, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });
}

const SPEC = `task: output demo
success_criteria:
  - it works
oracle:
  type: command
  run: "exit 0"
`;

/** Creates a one-node run and drives its task to a real receipt. Mirrors the
 * create→RED→GREEN→VERIFY→verify pipeline `cli.test.ts` already exercises,
 * reused here to reach a receipt quickly. Returns the task id; the task lives
 * in its own worktree, so callers that need the path derive it from the id. */
/** Where a task's receipt lives: inside its own worktree. */
const worktreeOf = (cwd: string, id: string) => join(cwd, ".sddx-worktrees", id);
const receiptOf = (cwd: string, id: string) =>
  join(worktreeOf(cwd, id), ".sddx", "receipts", `${id}.json`);

/** One task in its own one-node run, phases driven from inside its worktree. */
function makeTask(cwd: string, sentence: string, seq: number): { id: string; wt: string } {
  const { taskIds } = createRun(
    cwd,
    cli,
    `output demo ${seq}`,
    [{ alias: "only", spec: sentence }],
    {
      graphName: `graph-${seq}.yaml`,
    },
  );
  const id = taskIds[0] as string;
  return { id, wt: join(cwd, ".sddx-worktrees", id) };
}

let runSeq = 0;
function createAndVerify(cwd: string, sentence = SPEC): string {
  // A distinct goal per call: two runs in one repo would otherwise collide on
  // the run branch, which is derived from the goal sentence.
  runSeq += 1;
  const { taskIds } = createRun(
    cwd,
    cli,
    `produce a receipt ${runSeq}`,
    [{ alias: "only", spec: sentence }],
    { graphName: `graph-${runSeq}.yaml` },
  );
  const id = taskIds[0] as string;
  const wt = join(cwd, ".sddx-worktrees", id);
  cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
  cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(wt, "task", "phase", id, "VERIFY");
  fakeRedCheck(wt, id);
  const v = cli(wt, "verify", id);
  if (v.status !== 0) throw new Error(`verify failed: ${v.stderr}${v.stdout}`);
  return id;
}

describe("sddx board --output json", () => {
  test("data matches the freshly written BOARD.md, which is still written unconditionally", () => {
    const cwd = fixtureRepo();
    const id = createAndVerify(cwd);

    const jsonRun = cli(cwd, "board", "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.command).toBe("board");
    const row = envelope.data.tasks.find((t: { id: string }) => t.id === id);
    expect(row).toBeDefined();
    expect(row.rawPhase).toBe("DONE");
    expect(row.status).toBe("Completed");
    expect(row.receipt).toBe("#1");

    const board = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");
    expect(board).toContain(id);
    expect(board).toContain("Completed");
    expect(board).toContain("#1");
  });

  test("BOARD.md is written identically whether or not --output json is passed", () => {
    const cwd = fixtureRepo();
    createAndVerify(cwd);
    const withoutFlag = cli(cwd, "board");
    expect(withoutFlag.status).toBe(0);
    const boardAfterPlain = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");

    const withFlag = cli(cwd, "board", "--output", "json");
    expect(withFlag.status).toBe(0);
    const boardAfterJson = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");
    expect(boardAfterJson).toBe(boardAfterPlain);
  });
});

describe("sddx verify --output terminal vs --output json", () => {
  test("same verdict, exit code, and receipt presence/shape regardless of --output", () => {
    const cwdA = fixtureRepo();
    const { id: idA, wt: wtA } = makeTask(cwdA, SPEC, 1);
    cli(wtA, "task", "phase", idA, "RED", "--test-exit", "1");
    cli(wtA, "task", "phase", idA, "GREEN", "--test-exit", "0");
    cli(wtA, "task", "phase", idA, "VERIFY");
    fakeRedCheck(wtA, idA);
    const terminalRun = cli(wtA, "verify", idA);
    expect(terminalRun.status).toBe(0);
    const receiptA = JSON.parse(readFileSync(receiptOf(cwdA, idA), "utf8"));

    const cwdB = fixtureRepo();
    const { id: idB, wt: wtB } = makeTask(cwdB, SPEC, 1);
    cli(wtB, "task", "phase", idB, "RED", "--test-exit", "1");
    cli(wtB, "task", "phase", idB, "GREEN", "--test-exit", "0");
    cli(wtB, "task", "phase", idB, "VERIFY");
    fakeRedCheck(wtB, idB);
    const jsonRun = cli(wtB, "verify", idB, "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.data.verdict).toBe("pass");
    const receiptB = JSON.parse(readFileSync(receiptOf(cwdB, idB), "utf8"));

    // Two independently-created repos never share a base/tree SHA or timestamp —
    // what must match is the semantic outcome: same exit code, same verdict,
    // same oracle contract, and a receipt written in both cases.
    expect(terminalRun.status).toBe(jsonRun.status);
    expect(receiptA.verdict).toBe(receiptB.verdict);
    expect(receiptA.exit_code).toBe(receiptB.exit_code);
    expect(receiptA.oracle).toEqual(receiptB.oracle);
  });

  test("a failing oracle reports the same exit code and writes no receipt under either format", () => {
    const failSpec = `task: failing demo\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 1"\n`;

    const cwdA = fixtureRepo();
    const { id: idA, wt: wtA } = makeTask(cwdA, failSpec, 1);
    cli(wtA, "task", "phase", idA, "RED", "--test-exit", "1");
    cli(wtA, "task", "phase", idA, "GREEN", "--test-exit", "0");
    cli(wtA, "task", "phase", idA, "VERIFY");
    fakeRedCheck(wtA, idA);
    const terminalRun = cli(wtA, "verify", idA);
    expect(terminalRun.status).toBe(1);

    const cwdB = fixtureRepo();
    const { id: idB, wt: wtB } = makeTask(cwdB, failSpec, 1);
    cli(wtB, "task", "phase", idB, "RED", "--test-exit", "1");
    cli(wtB, "task", "phase", idB, "GREEN", "--test-exit", "0");
    cli(wtB, "task", "phase", idB, "VERIFY");
    fakeRedCheck(wtB, idB);
    const jsonRun = cli(wtB, "verify", idB, "--output", "json");
    expect(jsonRun.status).toBe(1);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.data.verdict).toBe("fail");
    expect(envelope.data.receiptPath).toBeNull();

    expect(existsSync(receiptOf(cwdA, idA))).toBe(false);
    expect(existsSync(receiptOf(cwdB, idB))).toBe(false);
  });
});

describe("sddx audit --output terminal vs --output json", () => {
  test("tampered chain exits 1 under both formats; JSON names the offending path", () => {
    const cwd = fixtureRepo();
    const id = createAndVerify(cwd);
    const receiptPath = receiptOf(cwd, id);
    chmodSync(receiptPath, 0o644);
    const original = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, JSON.stringify({ ...original, exit_code: 99 }, null, 2));

    // audit reads the receipt chain where it lives — inside the task's worktree
    const wt = worktreeOf(cwd, id);
    const terminalRun = cli(wt, "audit");
    expect(terminalRun.status).toBe(1);
    expect(terminalRun.stderr).toContain(`${id}.json`);

    const jsonRun = cli(wt, "audit", "--output", "json");
    expect(jsonRun.status).toBe(1);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.errors.some((e: string) => e.includes(`${id}.json`))).toBe(true);
  });
});

describe("two-task board summary (JSON + Markdown)", () => {
  test("board --output json/markdown lists both tasks with id, branch, phase, receipt", () => {
    const cwd = fixtureRepo();
    const idA = createAndVerify(
      cwd,
      `task: first thing\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
    );
    const idB = createAndVerify(
      cwd,
      `task: second thing\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
    );

    const jsonRun = cli(cwd, "board", "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    const ids = envelope.data.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    for (const t of envelope.data.tasks) {
      expect(t.rawPhase).toBe("DONE");
      expect(t.receipt).toMatch(/^#\d+$/);
    }

    const mdRun = cli(cwd, "board", "--output", "markdown");
    expect(mdRun.status).toBe(0);
    expect(mdRun.stdout).toContain("## Execution Summary");
    expect(mdRun.stdout).toContain("## Task Results");
    expect(mdRun.stdout).toContain(idA);
    expect(mdRun.stdout).toContain(idB);
  });
});

describe("sddx next-actions --output markdown", () => {
  test("a missing --goal renders through the framework, not as bare text", () => {
    // The current-branch menu is retired, so the reachable non-goal outcome is
    // the usage error — which must still come back as a proper envelope in
    // every format rather than as unstructured stderr.
    const cwd = fixtureRepo();
    const mdRun = cli(cwd, "next-actions", "--output", "markdown");
    expect(mdRun.status).not.toBe(0);
    expect(`${mdRun.stdout}${mdRun.stderr}`).toContain("--goal");

    const jsonRun = cli(cwd, "next-actions", "--output", "json");
    expect(jsonRun.status).not.toBe(0);
    const envelope = JSON.parse(`${jsonRun.stdout}${jsonRun.stderr}`.trim());
    expect(envelope.status).toBe("error");
    expect(envelope.errors.join(" ")).toContain("--goal");
  });
});
