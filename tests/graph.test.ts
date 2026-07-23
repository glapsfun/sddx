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
    expect(graph!.tasks[1]!.depends_on).toEqual(["schema"]);
    expect(graph!.tasks[0]!.depends_on).toEqual([]);
  });

  test("parses a fan-in node with a depends_on list", () => {
    const y =
      "goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: b\n    spec: b.yaml\n  - alias: d\n    spec: d.yaml\n    depends_on: [a, b]\n";
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    expect(graph!.tasks.find((t) => t.alias === "d")!.depends_on).toEqual(["a", "b"]);
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
  const n = (id: string, dependsOn: string | string[] | null, scope: string[]): ScheduleNode => ({
    id,
    dependsOn: dependsOn === null ? [] : Array.isArray(dependsOn) ? dependsOn : [dependsOn],
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

  test("fan-in (two parents, no cycle) is accepted when scopes are disjoint", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/a.ts"]),
        n("b", null, ["src/b.ts"]),
        n("d", ["a", "b"], ["src/d.ts"]),
      ]),
    ).toEqual([]);
  });

  test("co-parents of a shared fan-in child with overlapping scope are rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/shared/**"]),
      n("b", null, ["src/shared/x.ts"]),
      n("d", ["a", "b"], ["src/d.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"a"');
    expect(errs.join(" ")).toContain('"b"');
  });

  test("cycle through a multi-parent edge is rejected", () => {
    const errs = validateSchedule([n("a", ["c"], []), n("b", ["a"], []), n("c", ["b"], [])]);
    expect(errs.join(" ")).toContain("cycle");
  });

  test("a fan-in child may overlap either of its (disjoint) parents' scope", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/a.ts"]),
        n("b", null, ["src/b.ts"]),
        n("d", ["a", "b"], ["src/a.ts"]),
      ]),
    ).toEqual([]);
  });
});
