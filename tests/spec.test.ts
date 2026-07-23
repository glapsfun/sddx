import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/lib/spec";

const VALID = `
task: add a health endpoint
success_criteria:
  - "GET /health returns 200"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
out_of_scope:
  - auth
`;

describe("parseSpec", () => {
  test("accepts a valid spec and defaults expect to exit 0", () => {
    const { spec, errors } = parseSpec(VALID);
    expect(errors).toEqual([]);
    expect(spec!.task).toBe("add a health endpoint");
    expect(spec!.oracle.expect).toBe("exit 0");
    expect(spec!.out_of_scope).toEqual(["auth"]);
  });

  test("rejects a spec without an oracle — no oracle, no goal", () => {
    const { spec, errors } = parseSpec("task: t\nsuccess_criteria:\n  - a\n");
    expect(spec).toBeUndefined();
    expect(errors.join(" ")).toContain("oracle");
  });

  test("rejects a non-manual oracle without run", () => {
    const { errors } = parseSpec("task: t\nsuccess_criteria:\n  - a\noracle:\n  type: command\n");
    expect(errors.join(" ")).toContain("oracle.run");
  });

  test("rejects empty success_criteria and missing task", () => {
    const { errors } = parseSpec("oracle:\n  type: manual\n");
    expect(errors.some((e) => e.startsWith("task:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("success_criteria:"))).toBe(true);
  });

  test("rejects invalid YAML and non-mapping documents", () => {
    expect(parseSpec(":").errors.length).toBeGreaterThan(0);
    expect(parseSpec("- just\n- a list\n").errors).toEqual(["spec must be a YAML mapping"]);
  });

  test("rejects unknown oracle type", () => {
    const { errors } = parseSpec(
      "task: t\nsuccess_criteria:\n  - a\noracle:\n  type: vibes\n  run: x\n",
    );
    expect(errors.join(" ")).toContain("oracle.type");
  });

  test("accepts an optional scope and trims its globs", () => {
    const { spec, errors } = parseSpec(`${VALID}scope:\n  - " src/db/** "\n  - migrations/*.sql\n`);
    expect(errors).toEqual([]);
    expect(spec!.scope).toEqual(["src/db/**", "migrations/*.sql"]);
  });

  test("defaults scope to an empty list when omitted", () => {
    const { spec } = parseSpec(VALID);
    expect(spec!.scope).toEqual([]);
  });

  test("rejects an empty or non-string scope", () => {
    expect(parseSpec(`${VALID}scope: []\n`).errors.join(" ")).toContain("scope");
    expect(parseSpec(`${VALID}scope:\n  - ""\n`).errors.join(" ")).toContain("scope");
    expect(parseSpec(`${VALID}scope: "src/**"\n`).errors.join(" ")).toContain("scope");
  });

  test("accepts on_dependency_failure and retry, round-tripped", () => {
    const { spec, errors } = parseSpec(
      `${VALID}on_dependency_failure: block\nretry:\n  max_attempts: 3\n  workspace: reuse\n`,
    );
    expect(errors).toEqual([]);
    expect(spec!.on_dependency_failure).toBe("block");
    expect(spec!.retry).toEqual({ max_attempts: 3, workspace: "reuse" });
  });

  test("absent on_dependency_failure/retry leaves the spec unaffected", () => {
    const { spec, errors } = parseSpec(VALID);
    expect(errors).toEqual([]);
    expect(spec!.on_dependency_failure).toBeUndefined();
    expect(spec!.retry).toBeUndefined();
  });

  test("partial retry (max_attempts only) is accepted", () => {
    const { spec, errors } = parseSpec(`${VALID}retry:\n  max_attempts: 2\n`);
    expect(errors).toEqual([]);
    expect(spec!.retry).toEqual({ max_attempts: 2 });
  });

  test("rejects an invalid on_dependency_failure value", () => {
    expect(parseSpec(`${VALID}on_dependency_failure: retry\n`).errors.join(" ")).toContain(
      "on_dependency_failure",
    );
  });

  test("rejects a non-positive max_attempts", () => {
    expect(parseSpec(`${VALID}retry:\n  max_attempts: 0\n`).errors.join(" ")).toContain(
      "retry.max_attempts",
    );
  });

  test("rejects an invalid retry.workspace value", () => {
    expect(parseSpec(`${VALID}retry:\n  workspace: rebase\n`).errors.join(" ")).toContain(
      "retry.workspace",
    );
  });

  test("reports multiple bad fields together in one pass", () => {
    const { errors } = parseSpec(
      `${VALID}on_dependency_failure: nope\nretry:\n  max_attempts: 0\n  workspace: nope\n`,
    );
    expect(errors.some((e) => e.startsWith("on_dependency_failure:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("retry.max_attempts:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("retry.workspace:"))).toBe(true);
  });
});
