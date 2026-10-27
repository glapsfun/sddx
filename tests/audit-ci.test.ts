import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { fixtureRepo } from "./fixtures";
import { completeTask, createRun } from "./helpers";

describe("audit --ci", () => {
  test("repo with no sddx activity passes clean", () => {
    const cwd = fixtureRepo();
    expect(auditReceipts(cwd, { ci: true }).findings).toEqual([]);
  });

  test("DONE task without a receipt fails only under --ci", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    // forge DONE without a receipt — exactly what the gate must catch
    const path = join(cwd, ".sddx", "tasks", "T1.json");
    const t = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    t.phase = "DONE";
    writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
    expect(auditReceipts(cwd).findings).toEqual([]);
    const findings = auditReceipts(cwd, { ci: true }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("without a receipt");
  });

  test("a verified task passes under --ci", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    expect(auditReceipts(worktree, { ci: true }).findings).toEqual([]);
  });
});
