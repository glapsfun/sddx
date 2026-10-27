import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "./fixtures";
import { completeTask, createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";

setDefaultTimeout(60_000);

const receiptOf = (cwd: string, id: string) =>
  join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`);

/** A repo with one started task whose oracle is `run`, its oracle file written. */
function startedTask(run?: string): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  createRun(cwd, { tasks: [{ id: "T1", ...(run ? { run } : {}) }] });
  const wt = startTask(cwd, "T1");
  writeFileSync(join(wt, doneFile("T1")), "done\n");
  return { cwd, wt };
}

describe("sddx board --output json", () => {
  test("data matches the freshly written BOARD.md, which is still written unconditionally", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");

    const jsonRun = sddx(cwd, "board", "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.command).toBe("board");
    const row = envelope.data.tasks.find((t: { id: string }) => t.id === "T1");
    expect(row).toBeDefined();
    expect(row.state).toBe("DONE");
    expect(row.label).toBe("DONE");
    expect(row.receipt).toBe("#1");

    const board = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");
    expect(board).toContain("| T1 | 2026-01-01-test-goal | DONE |");
    expect(board).toContain("| #1 |");
  });

  test("BOARD.md is written identically whether or not --output json is passed", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    const withoutFlag = sddx(cwd, "board");
    expect(withoutFlag.status).toBe(0);
    const boardAfterPlain = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");

    const withFlag = sddx(cwd, "board", "--output", "json");
    expect(withFlag.status).toBe(0);
    const boardAfterJson = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");
    expect(boardAfterJson).toBe(boardAfterPlain);
  });
});

describe("sddx verify and review record: --output terminal vs --output json", () => {
  test("same verdict, exit code, state, and receipt shape regardless of --output", () => {
    const a = startedTask();
    const terminalVerify = sddx(a.cwd, "verify", "T1");
    const terminalReview = sddx(a.cwd, "review", "record", "T1", "--verdict", "pass");

    const b = startedTask();
    const jsonVerify = sddx(b.cwd, "verify", "T1", "--output", "json");
    expect(JSON.parse(jsonVerify.stdout).data).toMatchObject({
      verdict: "pass",
      phase: "IN_REVIEW",
    });
    const jsonReview = sddx(
      b.cwd,
      "review",
      "record",
      "T1",
      "--verdict",
      "pass",
      "--output",
      "json",
    );
    expect(JSON.parse(jsonReview.stdout).data).toMatchObject({ verdict: "pass", phase: "DONE" });

    expect(terminalVerify.status).toBe(0);
    expect(jsonVerify.status).toBe(terminalVerify.status);
    expect(terminalReview.status).toBe(0);
    expect(jsonReview.status).toBe(terminalReview.status);
    expect(readTaskState(a.cwd, "T1").phase).toBe(readTaskState(b.cwd, "T1").phase);

    // Two independently created repos never share a base/tree SHA or timestamp:
    // what must match is the semantic outcome, written in both cases.
    const receiptA = JSON.parse(readFileSync(receiptOf(a.cwd, "T1"), "utf8"));
    const receiptB = JSON.parse(readFileSync(receiptOf(b.cwd, "T1"), "utf8"));
    expect(receiptA.verdict).toBe(receiptB.verdict);
    expect(receiptA.oracle).toEqual(receiptB.oracle);
    expect(receiptA.runs.map((r: { exit_code: number }) => r.exit_code)).toEqual(
      receiptB.runs.map((r: { exit_code: number }) => r.exit_code),
    );
    expect(receiptA.review.verdict).toBe(receiptB.review.verdict);
  });

  test("a failing oracle reports the same exit code and leaves no receipt under either format", () => {
    const a = startedTask("exit 1");
    const terminalRun = sddx(a.cwd, "verify", "T1");
    expect(terminalRun.status).toBe(1);

    const b = startedTask("exit 1");
    const jsonRun = sddx(b.cwd, "verify", "T1", "--output", "json");
    expect(jsonRun.status).toBe(1);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.data.verdict).toBe("fail");
    expect(envelope.data.phase).toBe("IN_PROGRESS");
    expect(envelope.data.failure.half).toBe("green");

    for (const { cwd } of [a, b]) {
      expect(readTaskState(cwd, "T1").phase).toBe("IN_PROGRESS");
      expect(existsSync(receiptOf(cwd, "T1"))).toBe(false);
    }
  });
});

describe("sddx audit --output terminal vs --output json", () => {
  test("tampered chain exits 1 under both formats; JSON names the offending path", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree: wt, receiptPath } = completeTask(cwd, "T1");
    chmodSync(receiptPath, 0o644);
    const original = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(receiptPath, JSON.stringify({ ...original, verdict: "fail" }, null, 2));

    // audit reads the receipt chain where it lives: inside the task's worktree
    const terminalRun = sddx(wt, "audit");
    expect(terminalRun.status).toBe(1);
    expect(terminalRun.stderr).toContain("T1.json");

    const jsonRun = sddx(wt, "audit", "--output", "json");
    expect(jsonRun.status).toBe(1);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.errors.some((e: string) => e.includes("T1.json"))).toBe(true);
  });
});

describe("two-task board summary (JSON + Markdown)", () => {
  test("board --output json/markdown lists both tasks with id, state, and receipt", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    completeTask(cwd, "T1");
    completeTask(cwd, "T2");

    const jsonRun = sddx(cwd, "board", "--output", "json");
    expect(jsonRun.status).toBe(0);
    const envelope = JSON.parse(jsonRun.stdout);
    expect(envelope.data.tasks.map((t: { id: string }) => t.id)).toEqual(["T1", "T2"]);
    for (const t of envelope.data.tasks) {
      expect(t.state).toBe("DONE");
      expect(t.receipt).toMatch(/^#\d+$/);
    }

    const mdRun = sddx(cwd, "board", "--output", "markdown");
    expect(mdRun.status).toBe(0);
    expect(mdRun.stdout).toContain("## Execution Summary");
    expect(mdRun.stdout).toContain("## Task Results");
    expect(mdRun.stdout).toContain("| T1 |");
    expect(mdRun.stdout).toContain("| T2 |");
  });
});

describe("sddx next-actions --output markdown", () => {
  test("a missing --goal renders through the framework, not as bare text", () => {
    // The current-branch menu is retired, so the reachable non-goal outcome is
    // the usage error, which must still come back as a proper envelope in
    // every format rather than as unstructured stderr.
    const cwd = fixtureRepo();
    const mdRun = sddx(cwd, "next-actions", "--output", "markdown");
    expect(mdRun.status).not.toBe(0);
    expect(`${mdRun.stdout}${mdRun.stderr}`).toContain("--goal");

    const jsonRun = sddx(cwd, "next-actions", "--output", "json");
    expect(jsonRun.status).not.toBe(0);
    const envelope = JSON.parse(`${jsonRun.stdout}${jsonRun.stderr}`.trim());
    expect(envelope.status).toBe("error");
    expect(envelope.errors.join(" ")).toContain("--goal");
  });
});

test("board markdown shows each task's goal and state", () => {
  const cwd = fixtureRepo();
  createRun(cwd, { tasks: [{ id: "T1" }] });
  const md = sddx(cwd, "board", "--output", "markdown").stdout;
  expect(md).toContain("| Task | Goal | State | Receipt |");
  expect(md).toContain("| T1 | 2026-01-01-test-goal | PLANNED | - |");
});
