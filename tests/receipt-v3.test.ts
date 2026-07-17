import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headSha } from "../src/lib/git";
import { type Receipt, validateReceipt } from "../src/lib/receipt";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

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

describe("verifyTask writes v3", () => {
  test("receipt carries one run and captured env with dirty_tree true", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      'task: v3 fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n',
    ).spec!;
    let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
      mode: "none",
      branch: null,
      base_sha: headSha(cwd),
    });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "VERIFY");
    // forward-compat with Task 3's red-check gate on verify
    t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
    writeTask(cwd, t);
    writeFileSync(join(cwd, "impl.txt"), "code\n");

    const res = verifyTask(cwd, t.id, { pluginVersion: "0.2.0" });
    expect(res.verdict).toBe("pass");
    const receipt = JSON.parse(readFileSync(res.receiptPath!, "utf8")) as Receipt;
    expect(validateReceipt(receipt)).toEqual([]);
    expect(receipt.version).toBe(3);
    expect(receipt.runs).toHaveLength(1);
    expect(receipt.runs![0]!.exit_code).toBe(0);
    expect(receipt.env!.runtime === "bun" || receipt.env!.runtime === "node").toBe(true);
    expect(receipt.env!.runtime_version.length).toBeGreaterThan(0);
    expect(receipt.env!.dirty_tree).toBe(true); // impl.txt was uncommitted when the oracle ran
    expect(receipt.exit_code).toBeUndefined();
  });
});
