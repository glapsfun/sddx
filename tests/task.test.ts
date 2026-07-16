import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../src/lib/spec";
import { createTask, readTask, taskId, transition, writeTask } from "../src/lib/task";

const spec = parseSpec(
  "task: Add a Health endpoint!\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n",
).spec!;

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-task-"));
}

describe("taskId", () => {
  test("slugifies and date-prefixes", () => {
    expect(taskId("Add a Health endpoint!", new Date("2026-07-17T00:00:00Z"))).toBe(
      "20260717-add-a-health-endpoint",
    );
  });
});

describe("task state", () => {
  test("create + read roundtrip, starts in PLAN", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
      mode: "branch",
      branch: "sddx/x",
      base_sha: "abc",
    });
    expect(readTask(cwd, t.id).phase).toBe("PLAN");
    expect(() => createTask(cwd, spec, "s", t.workspace)).toThrow(/exists/);
  });

  test("legal path PLAN→RED→GREEN→REFACTOR→VERIFY with evidence", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "abc" });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "REFACTOR");
    t = transition(t, "VERIFY");
    expect(t.phase).toBe("VERIFY");
    expect(t.evidence.red?.test_exit).toBe(1);
    expect(t.evidence.green?.test_exit).toBe(0);
    expect(t.history.map((h) => h.phase)).toEqual(["PLAN", "RED", "GREEN", "REFACTOR", "VERIFY"]);
  });

  test("evidence gates: RED needs failing exit, GREEN needs passing exit", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "RED", { testExit: 0 })).toThrow(/failing test/);
    expect(() => transition(t, "RED")).toThrow(/failing test/);
    t = transition(t, "RED", { testExit: 1 });
    expect(() => transition(t, "GREEN", { testExit: 2 })).toThrow(/passing test/);
  });

  test("illegal jumps and model-claimed DONE are rejected", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "GREEN", { testExit: 0 })).toThrow(/PLAN → GREEN/);
    const v = { ...t, phase: "VERIFY" as const };
    expect(() => transition(v, "DONE")).toThrow(/verifier/);
    expect(transition(v, "DONE", { internal: true }).phase).toBe("DONE");
  });

  test("writeTask bumps updated_at", async () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const before = readTask(cwd, t.id).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    writeTask(cwd, t);
    expect(readTask(cwd, t.id).updated_at > before).toBe(true);
  });
});
