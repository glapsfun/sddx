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
    const { errors } = parseSpec(
      "task: t\nsuccess_criteria:\n  - a\noracle:\n  type: command\n",
    );
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
});
