import { describe, expect, test } from "bun:test";
import { type ScheduleNode, validateSchedule } from "../src/lib/plan";

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
    // the schedule check only orders tasks; plan check's own rules refuse a
    // dependency the spec does not define
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
