import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { headSha } from "../src/lib/git";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

describe("audit --ci", () => {
  test("repo with no sddx activity passes clean", () => {
    const cwd = fixtureRepo();
    expect(auditReceipts(cwd, { ci: true }).findings).toEqual([]);
  });

  test("DONE task without a receipt fails only under --ci", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      "task: ci fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n",
    ).spec!;
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: headSha(cwd) });
    // forge DONE without a receipt — exactly what the gate must catch
    t.phase = "DONE";
    writeTask(cwd, t);
    expect(auditReceipts(cwd).findings).toEqual([]);
    const findings = auditReceipts(cwd, { ci: true }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("without a receipt");
  });

  test("a verified task passes under --ci", () => {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      'task: ci ok\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n',
    ).spec!;
    let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
      mode: "none",
      branch: null,
      base_sha: headSha(cwd),
    });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "VERIFY");
    t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
    writeTask(cwd, t);
    writeFileSync(join(cwd, "impl.txt"), "code\n");
    expect(verifyTask(cwd, t.id, { pluginVersion: "0.2.0" }).verdict).toBe("pass");
    expect(auditReceipts(cwd, { ci: true }).findings).toEqual([]);
  });
});
