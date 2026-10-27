import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Receipt, sha256, validateReceipt } from "../src/lib/receipt";
import { fixtureRepo, writeConfig } from "./fixtures";
import { completeTask, createRun } from "./helpers";

/** One finished task in a goal run under `mode`, with its receipt and plan hash. */
function finishedRun(mode: "human" | "auto", assumptions?: string[]) {
  const cwd = fixtureRepo();
  if (mode === "auto") writeConfig(cwd, { interaction_mode: "auto" });
  const run = createRun(cwd, {
    tasks: [{ id: "T1" }],
    ...(assumptions ? { assumptions } : {}),
    approve: mode === "human",
  });
  const { receiptPath } = completeTask(cwd, "T1");
  return {
    receipt: JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt,
    planSha: sha256(readFileSync(join(cwd, run.specPath))),
  };
}

describe("receipt approval provenance", () => {
  test("a goal task's receipt carries mode and plan hash", () => {
    const { receipt: r, planSha } = finishedRun("auto");
    expect(r.version).toBe(5);
    expect(r.approval?.mode).toBe("auto");
    expect(r.approval?.plan_sha256).toBe(planSha);
    expect(r.approval?.amendments).toEqual([]);
    expect(validateReceipt(r)).toEqual([]);
  });

  test("the receipt is interpretable without opening the goal file", () => {
    const { receipt: r, planSha } = finishedRun("human", ["the project uses Vite"]);
    // everything needed to state the conditions of verification, in one file
    expect(r.approval?.mode).toBe("human");
    expect(r.approval?.plan_sha256).toBe(planSha);
    expect(r.approval?.assumptions).toEqual(["the project uses Vite"]);
  });

  test("auto-mode work is permanently marked", () => {
    const { receipt: r } = finishedRun("auto");
    expect(r.approval?.mode).toBe("auto");
    expect(r.approval?.authorization).toBe("auto");
    expect(r.approval?.binding).toBe("unsigned");
  });

  test("a version 5 receipt without approval is invalid: every task belongs to a goal", () => {
    const { receipt } = finishedRun("human");
    expect(validateReceipt({ ...receipt, approval: undefined })).toContain(
      "approval: missing or invalid",
    );
  });
});

describe("receipt schema back-compatibility", () => {
  const base = {
    task_id: "t",
    seq: 1,
    prev: "genesis",
    harness: "h",
    model: null,
    plugin_version: "1",
    oracle: { run: "true", expect: "exit 0" },
    base_sha: "0".repeat(40),
    tree_sha: "1".repeat(40),
    verdict: "pass",
    verified_at: new Date().toISOString(),
  };
  const v3runs = {
    runs: [
      {
        exit_code: 0,
        duration_ms: 1,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
      },
    ],
    env: { os: "linux", arch: "x64", runtime: "bun", runtime_version: "1", dirty_tree: false },
    allow: [],
  };

  test("v1 (no allow, no approval) still validates", () => {
    expect(
      validateReceipt({
        ...base,
        version: 1,
        exit_code: 0,
        duration_ms: 1,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
      }),
    ).toEqual([]);
  });

  test("v2 (allow, no approval) still validates", () => {
    expect(
      validateReceipt({
        ...base,
        version: 2,
        allow: [],
        exit_code: 0,
        duration_ms: 1,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
      }),
    ).toEqual([]);
  });

  test("v3 (runs/env, no approval) still validates", () => {
    expect(validateReceipt({ ...base, version: 3, ...v3runs })).toEqual([]);
  });

  test("v3 carrying an approval block is rejected", () => {
    const errs = validateReceipt({
      ...base,
      version: 3,
      ...v3runs,
      approval: { mode: "auto", plan_sha256: "a".repeat(64), assumptions: [], amendments: [] },
    });
    expect(errs.join("\n")).toContain("approval");
  });

  test("v4 requires a well-formed approval block when present", () => {
    expect(
      validateReceipt({
        ...base,
        version: 4,
        ...v3runs,
        approval: {
          mode: "human",
          plan_sha256: "a".repeat(64),
          at: new Date().toISOString(),
          assumptions: [],
          amendments: [],
        },
      }),
    ).toEqual([]);

    for (const bad of [
      { mode: "yolo", plan_sha256: "a".repeat(64), assumptions: [], amendments: [] },
      { mode: "human", plan_sha256: "nothex", assumptions: [], amendments: [] },
      { mode: "human", plan_sha256: "a".repeat(64), assumptions: "no", amendments: [] },
      { mode: "human", plan_sha256: "a".repeat(64), assumptions: [], amendments: ["x"] },
      // the binding is a version 5 field; a v4 receipt claiming one is forged
      {
        mode: "human",
        plan_sha256: "a".repeat(64),
        assumptions: [],
        amendments: [],
        binding: "signed",
      },
    ]) {
      const errs = validateReceipt({ ...base, version: 4, ...v3runs, approval: bad });
      expect(errs.join("\n")).toContain("approval");
    }
  });

  test("a historical v4 receipt recording a degraded run still validates", () => {
    // Nothing writes requested_mode/degraded_reason any more (an auto plan over a
    // bound is refused), but receipts on disk carry them and must keep auditing.
    expect(
      validateReceipt({
        ...base,
        version: 4,
        ...v3runs,
        approval: {
          mode: "human",
          requested_mode: "auto",
          degraded_reason: "plan has 9 nodes, over the auto_max_tasks ceiling of 6",
          plan_sha256: "d".repeat(64),
          assumptions: [],
          amendments: [],
        },
      }),
    ).toEqual([]);
  });

  test("v4 without approval is valid — a goal-less task", () => {
    expect(validateReceipt({ ...base, version: 4, ...v3runs })).toEqual([]);
  });
});
