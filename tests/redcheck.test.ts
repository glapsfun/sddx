import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { headSha } from "../src/lib/git";
import { redCheck } from "../src/lib/redcheck";
import { parseSpec } from "../src/lib/spec";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

function taskInRed(cwd: string, oracleRun: string) {
  const spec = parseSpec(
    `task: red fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "${oracleRun}"\n`,
  ).spec!;
  let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: headSha(cwd),
  });
  t = transition(t, "RED", { testExit: 1 });
  writeTask(cwd, t);
  return t;
}

describe("redCheck", () => {
  test("failing oracle in RED records oracle_red evidence", () => {
    const cwd = fixtureRepo();
    const t = taskInRed(cwd, "exit 7");
    const res = redCheck(cwd, t.id);
    expect(res).toEqual({ ok: true, exitCode: 7 });
    const after = readTask(cwd, t.id);
    expect(after.evidence.oracle_red!.exit_code).toBe(7);
    expect(after.evidence.oracle_red!.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("pre-passing oracle is rejected and records nothing", () => {
    const cwd = fixtureRepo();
    const t = taskInRed(cwd, "exit 0");
    expect(redCheck(cwd, t.id)).toEqual({ ok: false, exitCode: 0 });
    expect(readTask(cwd, t.id).evidence.oracle_red).toBeUndefined();
  });

  test("requires phase RED", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      "task: p\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n",
    ).spec!;
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: headSha(cwd) });
    writeTask(cwd, t);
    expect(() => redCheck(cwd, t.id)).toThrow(/RED/);
  });
});

describe("verify enforces the red-check", () => {
  function toVerify(cwd: string, t: ReturnType<typeof taskInRed>) {
    let task = readTask(cwd, t.id);
    task = transition(task, "GREEN", { testExit: 0 });
    task = transition(task, "VERIFY");
    writeTask(cwd, task);
    return task;
  }

  test("missing oracle_red → verify throws", () => {
    const cwd = fixtureRepo();
    const t = taskInRed(cwd, "exit 0");
    toVerify(cwd, t);
    expect(() => verifyTask(cwd, t.id, { pluginVersion: "0.2.0" })).toThrow(/red-check/);
  });

  test("oracle_red after first GREEN → verify throws", () => {
    const cwd = fixtureRepo();
    const t = taskInRed(cwd, "exit 0");
    const task = toVerify(cwd, t);
    task.evidence.oracle_red = { exit_code: 1, at: new Date(Date.now() + 60_000).toISOString() };
    writeTask(cwd, task);
    expect(() => verifyTask(cwd, t.id, { pluginVersion: "0.2.0" })).toThrow(/first GREEN/);
  });

  test("happy path: red-check → green → verify passes", () => {
    const cwd = fixtureRepo();
    // fails while impl.txt is missing, passes after it exists
    const t = taskInRed(cwd, "test -f impl.txt");
    expect(redCheck(cwd, t.id).ok).toBe(true);
    writeFileSync(join(cwd, "impl.txt"), "code\n");
    toVerify(cwd, t);
    expect(verifyTask(cwd, t.id, { pluginVersion: "0.2.0" }).verdict).toBe("pass");
  });
});
