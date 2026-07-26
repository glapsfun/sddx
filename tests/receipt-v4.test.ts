import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headSha } from "../src/lib/git";
import { createGoal } from "../src/lib/goal";
import { type Receipt, validateReceipt } from "../src/lib/receipt";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

const SPEC = (task: string, assumptions?: string[]) => `task: ${task}
success_criteria:
  - "it works"
${assumptions ? `assumptions:\n${assumptions.map((a) => `  - "${a}"`).join("\n")}\n` : ""}oracle:
  type: command
  run: "true"
`;

/** A task driven to VERIFY, ready for verifyTask. */
function readyTask(cwd: string, spec: string) {
  const parsed = parseSpec(spec);
  expect(parsed.errors).toEqual([]);
  const t = createTask(cwd, parsed.spec as NonNullable<typeof parsed.spec>, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: headSha(cwd),
  });
  let cur = transition(t, "RED", { testExit: 1 });
  cur = transition(cur, "GREEN", { testExit: 0 });
  cur = transition(cur, "VERIFY");
  cur.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(cwd, cur);
  return cur;
}

const verify = (cwd: string, id: string) =>
  verifyTask(cwd, id, { harness: "test", model: null, pluginVersion: "test" });

describe("receipt v4 approval provenance", () => {
  test("a goal task's receipt carries mode and plan hash", () => {
    const cwd = fixtureRepo();
    const t = readyTask(cwd, SPEC("do the widget work"));
    createGoal(cwd, "ship the widget", [t.id], {
      runBranch: "sddx/run-x",
      baseSha: headSha(cwd),
      approval: { mode: "auto", plan_sha256: "a".repeat(64), at: new Date().toISOString() },
    });

    const res = verify(cwd, t.id);
    expect(res.verdict).toBe("pass");
    const r = JSON.parse(
      readFileSync(join(cwd, ".sddx", "receipts", `${t.id}.json`), "utf8"),
    ) as Receipt;
    expect(r.version).toBe(4);
    expect(r.approval?.mode).toBe("auto");
    expect(r.approval?.plan_sha256).toBe("a".repeat(64));
    expect(r.approval?.amendments).toEqual([]);
    expect(validateReceipt(r)).toEqual([]);
  });

  test("the receipt is interpretable without opening the goal file", () => {
    const cwd = fixtureRepo();
    const t = readyTask(cwd, SPEC("do the widget work", ["the project uses Vite"]));
    createGoal(cwd, "ship the widget", [t.id], {
      runBranch: "sddx/run-x",
      baseSha: headSha(cwd),
      approval: { mode: "human", plan_sha256: "b".repeat(64), at: new Date().toISOString() },
    });
    verify(cwd, t.id);

    const r = JSON.parse(
      readFileSync(join(cwd, ".sddx", "receipts", `${t.id}.json`), "utf8"),
    ) as Receipt;
    // everything needed to state the conditions of verification, in one file
    expect(r.approval?.mode).toBe("human");
    expect(r.approval?.plan_sha256).toBe("b".repeat(64));
    expect(r.approval?.assumptions).toEqual(["the project uses Vite"]);
  });

  test("auto-mode work is permanently marked", () => {
    const cwd = fixtureRepo();
    const t = readyTask(cwd, SPEC("do the widget work"));
    createGoal(cwd, "ship the widget", [t.id], {
      runBranch: "sddx/run-x",
      baseSha: headSha(cwd),
      approval: { mode: "auto", plan_sha256: "c".repeat(64), at: new Date().toISOString() },
    });
    verify(cwd, t.id);
    const r = JSON.parse(
      readFileSync(join(cwd, ".sddx", "receipts", `${t.id}.json`), "utf8"),
    ) as Receipt;
    expect(r.approval?.mode).toBe("auto");
  });

  test("a goal-less task omits approval and stays valid at v3", () => {
    const cwd = fixtureRepo();
    const t = readyTask(cwd, SPEC("do the standalone work"));
    const res = verify(cwd, t.id);
    expect(res.verdict).toBe("pass");
    const r = JSON.parse(
      readFileSync(join(cwd, ".sddx", "receipts", `${t.id}.json`), "utf8"),
    ) as Receipt;
    expect(r.approval).toBeUndefined();
    expect(validateReceipt(r)).toEqual([]);
  });

  test("degradation from auto to human is recorded on the receipt", () => {
    const cwd = fixtureRepo();
    const t = readyTask(cwd, SPEC("do the widget work"));
    createGoal(cwd, "ship the widget", [t.id], {
      runBranch: "sddx/run-x",
      baseSha: headSha(cwd),
      approval: {
        mode: "human",
        requested_mode: "auto",
        degraded_reason: "plan has 9 nodes, over the auto_max_tasks ceiling of 6",
        plan_sha256: "d".repeat(64),
        at: new Date().toISOString(),
      },
    });
    verify(cwd, t.id);
    const r = JSON.parse(
      readFileSync(join(cwd, ".sddx", "receipts", `${t.id}.json`), "utf8"),
    ) as Receipt;
    expect(r.approval?.mode).toBe("human");
    expect(r.approval?.requested_mode).toBe("auto");
    expect(r.approval?.degraded_reason).toContain("auto_max_tasks");
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
    ]) {
      const errs = validateReceipt({ ...base, version: 4, ...v3runs, approval: bad });
      expect(errs.join("\n")).toContain("approval");
    }
  });

  test("v4 without approval is valid — a goal-less task", () => {
    expect(validateReceipt({ ...base, version: 4, ...v3runs })).toEqual([]);
  });
});
