import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Receipt, validateReceipt } from "../src/lib/receipt";
import { fixtureRepo } from "./fixtures";
import { completeTask, createRun } from "./helpers";

const HEX = "a".repeat(64);
const SHA40 = "b".repeat(40);

function validV3(): Receipt {
  return {
    version: 3,
    task_id: "t",
    seq: 1,
    prev: "genesis",
    harness: "claude-code",
    model: null,
    plugin_version: "0.2.0",
    oracle: { run: "exit 0", expect: "exit 0" },
    runs: [{ exit_code: 0, duration_ms: 5, stdout_sha256: HEX, stderr_sha256: HEX }],
    env: {
      os: "darwin",
      arch: "arm64",
      runtime: "bun",
      runtime_version: "1.2.0",
      dirty_tree: true,
    },
    base_sha: SHA40,
    tree_sha: SHA40,
    verdict: "pass",
    verified_at: new Date().toISOString(),
    allow: [],
  };
}

describe("receipt v3 schema", () => {
  test("valid v3 passes; signature fields are both-or-neither", () => {
    expect(validateReceipt(validV3())).toEqual([]);
    const signed = {
      ...validV3(),
      signature: "-----BEGIN SSH SIGNATURE-----\nx\n-----END SSH SIGNATURE-----",
      signer: "a@b.c",
    };
    expect(validateReceipt(signed)).toEqual([]);
    const half = { ...validV3(), signature: "sig" };
    expect(validateReceipt(half).length).toBeGreaterThan(0);
  });

  test("v3 requires runs[] and env, forbids v2 run fields", () => {
    const noRuns = { ...validV3(), runs: [] };
    expect(validateReceipt(noRuns).some((e) => e.startsWith("runs"))).toBe(true);
    const noEnv = { ...validV3(), env: undefined };
    expect(validateReceipt(noEnv).some((e) => e.startsWith("env"))).toBe(true);
    const mixed = { ...validV3(), exit_code: 0 };
    expect(validateReceipt(mixed).some((e) => e.startsWith("exit_code"))).toBe(true);
  });

  test("v2 still validates and forbids v3 fields", () => {
    const v2: Receipt = {
      ...validV3(),
      version: 2,
      runs: undefined,
      env: undefined,
      exit_code: 0,
      duration_ms: 5,
      stdout_sha256: HEX,
      stderr_sha256: HEX,
    };
    expect(validateReceipt(v2)).toEqual([]);
    expect(validateReceipt({ ...v2, runs: [] }).some((e) => e.startsWith("runs"))).toBe(true);
  });
});

describe("finalizing writes the current receipt version", () => {
  test("receipt carries one run and captured env with dirty_tree true", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { receiptPath } = completeTask(cwd, "T1");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
    expect(validateReceipt(receipt)).toEqual([]);
    expect(receipt.version).toBe(5);
    expect(receipt.runs).toHaveLength(1);
    expect(receipt.runs![0]!.exit_code).toBe(0);
    expect(receipt.env!.runtime).toBe("bun");
    expect(receipt.env!.runtime_version.length).toBeGreaterThan(0);
    // the change is staged but not yet committed when finalize captures the env
    expect(receipt.env!.dirty_tree).toBe(true);
    expect(receipt.exit_code).toBeUndefined();
  });
});
