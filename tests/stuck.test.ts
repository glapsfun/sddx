import { describe, expect, test } from "bun:test";
import { renderBoard } from "../src/board";
import { headSha } from "../src/lib/git";
import { failureFingerprint, recordTestRun } from "../src/lib/recorder";
import { parseSpec } from "../src/lib/spec";
import { stopGate } from "../src/lib/stopgate";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

function repoWithRedTask() {
  const cwd = fixtureRepo();
  const spec = parseSpec(
    "task: stuck fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n",
  ).spec!;
  let t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: headSha(cwd) });
  t = transition(t, "RED", { testExit: 1 });
  writeTask(cwd, t);
  return { cwd, id: t.id };
}

describe("failureFingerprint", () => {
  test("stable across numeric noise, distinct across different failures", () => {
    const a = failureFingerprint(1, "FAIL x.test.ts\n1 fail in 12.3ms");
    const b = failureFingerprint(1, "FAIL x.test.ts\n1 fail in 99.9ms");
    const c = failureFingerprint(1, "FAIL y.test.ts\nother error");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("stuck tracking", () => {
  test("three identical failures set stuck; different output resets; success clears", () => {
    const { cwd, id } = repoWithRedTask();
    const failOut = "FAIL same assertion";
    for (let i = 1; i <= 3; i += 1) {
      const res = recordTestRun(cwd, "bun test", 1, failOut);
      expect(readTask(cwd, id).stuck?.count).toBe(i);
      if (i === 3) expect(res.stuck).toEqual({ count: 3, threshold: 3 });
      else expect(res.stuck).toBeUndefined();
    }
    recordTestRun(cwd, "bun test", 1, "FAIL a different assertion");
    expect(readTask(cwd, id).stuck?.count).toBe(1);
    recordTestRun(cwd, "bun test", 0, "all pass");
    expect(readTask(cwd, id).stuck).toBeUndefined();
  });

  test("stop gate allows stopping a stuck task with an escalation note", () => {
    const { cwd, id } = repoWithRedTask();
    for (let i = 0; i < 3; i += 1) recordTestRun(cwd, "bun test", 1, "FAIL same");
    const d = stopGate({ cwd });
    expect(d.block).toBe(false);
    expect(d.note).toContain(id);
    expect(d.note).toContain("stuck");
  });

  test("board marks stuck tasks", () => {
    const { cwd, id } = repoWithRedTask();
    for (let i = 0; i < 3; i += 1) recordTestRun(cwd, "bun test", 1, "FAIL same");
    expect(renderBoard(cwd)).toContain(`| ${id} | RED ⚠stuck |`);
  });
});
