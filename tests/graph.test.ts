import { describe, expect, test } from "bun:test";
import { parseGraph, type ScheduleNode, validateSchedule } from "../src/lib/graph";

describe("parseGraph", () => {
  const GOOD = `goal: ship the thing
tasks:
  - alias: schema
    spec: specs/schema.yaml
  - alias: api
    spec: specs/api.yaml
    depends_on: schema
`;

  test("parses a well-formed graph with a root and a dependent", () => {
    const { graph, errors } = parseGraph(GOOD);
    expect(errors).toEqual([]);
    expect(graph!.goal).toBe("ship the thing");
    expect(graph!.tasks.map((t) => t.alias)).toEqual(["schema", "api"]);
    expect(graph!.tasks[1]!.depends_on).toBe("schema");
    expect(graph!.tasks[0]!.depends_on).toBeNull();
  });

  test("rejects duplicate alias", () => {
    const y = "goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: a\n    spec: b.yaml\n";
    expect(parseGraph(y).errors.join(" ")).toContain("duplicate alias");
  });

  test("rejects unknown depends_on alias", () => {
    const y = "goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n    depends_on: ghost\n";
    expect(parseGraph(y).errors.join(" ")).toContain("unknown alias");
  });

  test("rejects self-dependency", () => {
    const y = "goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n    depends_on: a\n";
    expect(parseGraph(y).errors.join(" ")).toContain("cannot depend on itself");
  });

  test("rejects missing goal or empty tasks", () => {
    expect(parseGraph("tasks:\n  - alias: a\n    spec: a.yaml\n").errors.join(" ")).toContain(
      "goal",
    );
    expect(parseGraph("goal: g\ntasks: []\n").errors.join(" ")).toContain("tasks");
  });
});

describe("validateSchedule (overlap ⟹ ordered)", () => {
  const n = (id: string, dependsOn: string | null, scope: string[]): ScheduleNode => ({
    id,
    dependsOn,
    scope,
  });

  test("concurrent overlapping tasks rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/db/**"]),
      n("b", null, ["src/db/schema.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"a"');
    expect(errs.join(" ")).toContain('"b"');
  });

  test("ancestor-ordered overlapping tasks accepted", () => {
    expect(
      validateSchedule([n("a", null, ["src/db/**"]), n("b", "a", ["src/db/schema.ts"])]),
    ).toEqual([]);
  });

  test("disjoint concurrent tasks accepted", () => {
    expect(validateSchedule([n("a", null, ["src/api/**"]), n("b", null, ["src/db/**"])])).toEqual(
      [],
    );
  });

  test("sibling overlap under a shared parent rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/root.ts"]),
      n("b", "a", ["src/shared/**"]),
      n("c", "a", ["src/shared/x.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"b"');
    expect(errs.join(" ")).toContain('"c"');
  });

  test("transitive ancestor ordering allows overlap down a chain", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/x.ts"]),
        n("b", "a", ["src/y.ts"]),
        n("c", "b", ["src/x.ts"]),
      ]),
    ).toEqual([]);
  });

  test("cycle rejected", () => {
    const errs = validateSchedule([n("a", "b", []), n("b", "a", [])]);
    expect(errs.join(" ")).toContain("cycle");
  });

  test("an external (unlisted) parent is tolerated, not an error", () => {
    // `goal create` may list a child whose parent shipped in another goal — the
    // external edge is treated as already-satisfied, not "unknown". Resolvability
    // within a graph is parseGraph's job (tested above).
    expect(validateSchedule([n("a", "external-parent", ["src/a.ts"])])).toEqual([]);
  });

  test("legacy all-root, no-scope goal passes unchanged", () => {
    expect(validateSchedule([n("a", null, []), n("b", null, []), n("c", null, [])])).toEqual([]);
  });
});
