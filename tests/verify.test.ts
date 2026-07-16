import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureRepo } from "./fixtures";
import { parseSpec } from "../src/lib/spec";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { headSha } from "../src/lib/git";
import { validateReceipt } from "../src/lib/receipt";
import { verifyTask } from "../src/lib/verify";

function taskInVerify(cwd: string, oracleRun: string) {
  const spec = parseSpec(
    `task: fixture task\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "${oracleRun}"\n`,
  ).spec!;
  let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: headSha(cwd),
  });
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  writeTask(cwd, t);
  return t;
}

describe("verifyTask", () => {
  test("pass: receipt + atomic commit with code, spec, task, receipt", () => {
    const cwd = fixtureRepo();
    const t = taskInVerify(cwd, "exit 0");
    writeFileSync(join(cwd, "impl.txt"), "code\n");
    const res = verifyTask(cwd, t.id, { pluginVersion: "0.0.1" });
    expect(res.verdict).toBe("pass");
    expect(readTask(cwd, t.id).phase).toBe("DONE");

    const receipt = JSON.parse(readFileSync(res.receiptPath!, "utf8"));
    expect(validateReceipt(receipt)).toEqual([]);
    expect(receipt.prev).toBe("genesis");
    expect(receipt.base_sha).toBe(t.workspace.base_sha);

    const files = spawnSync(
      "git",
      ["show", "--name-only", "--format=", "HEAD"],
      { cwd, encoding: "utf8" },
    ).stdout.trim().split("\n");
    expect(files).toContain("impl.txt");
    expect(files).toContain(`.sddx/tasks/${t.id}.json`);
    expect(files).toContain(`.sddx/receipts/${t.id}.json`);
    expect(headSha(cwd)).toBe(res.commitSha!);
  });

  test("fail: no receipt, no commit, phase stays VERIFY, attempt recorded", () => {
    const cwd = fixtureRepo();
    const t = taskInVerify(cwd, "exit 3");
    const before = headSha(cwd);
    const res = verifyTask(cwd, t.id, { pluginVersion: "0.0.1" });
    expect(res.verdict).toBe("fail");
    expect(res.exitCode).toBe(3);
    const after = readTask(cwd, t.id);
    expect(after.phase).toBe("VERIFY");
    expect(after.iterations).toBe(1);
    expect(headSha(cwd)).toBe(before);
    expect(res.receiptPath).toBeUndefined();
  });

  test("requires phase VERIFY and rejects manual oracles", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      "task: t2\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n",
    ).spec!;
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: headSha(cwd) });
    writeTask(cwd, t);
    expect(() => verifyTask(cwd, t.id, { pluginVersion: "0" })).toThrow(/VERIFY/);
  });
});
