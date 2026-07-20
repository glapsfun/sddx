import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { headSha } from "../src/lib/git";
import type { Receipt } from "../src/lib/receipt";
import { parseSpec } from "../src/lib/spec";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

function taskInVerify(cwd: string, oracleYaml: string) {
  const spec = parseSpec(`task: flaky fixture\nsuccess_criteria:\n  - a\noracle:\n${oracleYaml}`)
    .spec!;
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
  return t;
}

describe("oracle.runs", () => {
  test("spec parses runs and rejects non-positive values", () => {
    const ok = parseSpec(
      "task: t\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n  runs: 3\n",
    );
    expect(ok.spec!.oracle.runs).toBe(3);
    const bad = parseSpec(
      "task: t\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n  runs: 0\n",
    );
    expect(bad.errors.some((e) => e.startsWith("oracle.runs"))).toBe(true);
  });

  test("N stable runs all land in the receipt", () => {
    const cwd = fixtureRepo();
    const t = taskInVerify(cwd, '  type: command\n  run: "exit 0"\n  runs: 3\n');
    const res = verifyTask(cwd, t.id, { pluginVersion: "0.2.0" });
    expect(res.verdict).toBe("pass");
    const receipt = JSON.parse(readFileSync(res.receiptPath!, "utf8")) as Receipt;
    expect(receipt.runs).toHaveLength(3);
    expect(receipt.runs!.every((r) => r.exit_code === 0)).toBe(true);
  });

  test("a single flaky failure fails the verification — no receipt", () => {
    const cwd = fixtureRepo();
    // passes on run 1 (creates the flag), fails on run 2
    const t = taskInVerify(
      cwd,
      '  type: command\n  run: "if [ -f flag ]; then exit 1; else touch flag; exit 0; fi"\n  runs: 3\n',
    );
    const res = verifyTask(cwd, t.id, { pluginVersion: "0.2.0" });
    expect(res.verdict).toBe("fail");
    expect(res.receiptPath).toBeUndefined();
    expect(readTask(cwd, t.id).phase).toBe("VERIFY");
  });
});
