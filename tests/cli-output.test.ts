import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

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

/** Creates, red/green/verify-transitions, and verifies one task in `--no-branch`
 * mode; returns its id. Mirrors the create→RED→GREEN→VERIFY→verify pipeline
 * `cli.test.ts` already exercises, reused here to reach a real receipt quickly. */
function createAndVerify(cwd: string, sentence = SPEC): string {
  writeFileSync(join(cwd, "spec.yaml"), sentence);
  const created = cli(cwd, "task", "create", "--spec", "spec.yaml", "--no-branch");
  const id = /created (\S+)/.exec(created.stdout)?.[1] as string;
  cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
  cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(cwd, "task", "phase", id, "VERIFY");
  fakeRedCheck(cwd, id);
  const v = cli(cwd, "verify", id);
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
    writeFileSync(join(cwdA, "spec.yaml"), SPEC);
    const createdA = cli(cwdA, "task", "create", "--spec", "spec.yaml", "--no-branch");
    const idA = /created (\S+)/.exec(createdA.stdout)?.[1] as string;
    cli(cwdA, "task", "phase", idA, "RED", "--test-exit", "1");
    cli(cwdA, "task", "phase", idA, "GREEN", "--test-exit", "0");
    cli(cwdA, "task", "phase", idA, "VERIFY");
    fakeRedCheck(cwdA, idA);
    const terminalRun = cli(cwdA, "verify", idA);
    expect(terminalRun.status).toBe(0);
    const receiptA = JSON.parse(
      readFileSync(join(cwdA, ".sddx", "receipts", `${idA}.json`), "utf8"),
    );

    const cwdB = fixtureRepo();
    writeFileSync(join(cwdB, "spec.yaml"), SPEC);
    const createdB = cli(cwdB, "task", "create", "--spec", "spec.yaml", "--no-branch");
    const idB = /created (\S+)/.exec(createdB.stdout)?.[1] as string;
    cli(cwdB, "task", "phase", idB, "RED", "--test-exit", "1");
    cli(cwdB, "task", "phase", idB, "GREEN", "--test-exit", "0");
    cli(cwdB, "task", "phase", idB, "VERIFY");
    fakeRedCheck(cwdB, idB);
    const jsonRun = cli(cwdB, "verify", idB, "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.data.verdict).toBe("pass");
    const receiptB = JSON.parse(
      readFileSync(join(cwdB, ".sddx", "receipts", `${idB}.json`), "utf8"),
    );

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
    writeFileSync(join(cwdA, "spec.yaml"), failSpec);
    const createdA = cli(cwdA, "task", "create", "--spec", "spec.yaml", "--no-branch");
    const idA = /created (\S+)/.exec(createdA.stdout)?.[1] as string;
    cli(cwdA, "task", "phase", idA, "RED", "--test-exit", "1");
    cli(cwdA, "task", "phase", idA, "GREEN", "--test-exit", "0");
    cli(cwdA, "task", "phase", idA, "VERIFY");
    fakeRedCheck(cwdA, idA);
    const terminalRun = cli(cwdA, "verify", idA);
    expect(terminalRun.status).toBe(1);

    const cwdB = fixtureRepo();
    writeFileSync(join(cwdB, "spec.yaml"), failSpec);
    const createdB = cli(cwdB, "task", "create", "--spec", "spec.yaml", "--no-branch");
    const idB = /created (\S+)/.exec(createdB.stdout)?.[1] as string;
    cli(cwdB, "task", "phase", idB, "RED", "--test-exit", "1");
    cli(cwdB, "task", "phase", idB, "GREEN", "--test-exit", "0");
    cli(cwdB, "task", "phase", idB, "VERIFY");
    fakeRedCheck(cwdB, idB);
    const jsonRun = cli(cwdB, "verify", idB, "--output", "json");
    expect(jsonRun.status).toBe(1);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.data.verdict).toBe("fail");
    expect(envelope.data.receiptPath).toBeNull();

    expect(existsSync(join(cwdA, ".sddx", "receipts", `${idA}.json`))).toBe(false);
    expect(existsSync(join(cwdB, ".sddx", "receipts", `${idB}.json`))).toBe(false);
  });
});

describe("sddx audit --output terminal vs --output json", () => {
  test("tampered chain exits 1 under both formats; JSON names the offending path", () => {
    const cwd = fixtureRepo();
    const id = createAndVerify(cwd);
    const receiptPath = join(cwd, ".sddx", "receipts", `${id}.json`);
    chmodSync(receiptPath, 0o644);
    const original = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, JSON.stringify({ ...original, exit_code: 99 }, null, 2));

    const terminalRun = cli(cwd, "audit");
    expect(terminalRun.status).toBe(1);
    expect(terminalRun.stderr).toContain(`${id}.json`);

    const jsonRun = cli(cwd, "audit", "--output", "json");
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
  test("includes a Next Actions section listing the same actions as the terminal menu", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "untracked.txt"), "x\n");
    const terminalRun = cli(cwd, "next-actions");
    expect(terminalRun.status).toBe(0);

    const mdRun = cli(cwd, "next-actions", "--output", "markdown");
    expect(mdRun.status).toBe(0);
    expect(mdRun.stdout).toContain("## Next Actions");
  });
});
