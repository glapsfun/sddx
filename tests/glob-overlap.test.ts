import { describe, expect, test } from "bun:test";
import { overlaps, scopesOverlap } from "../src/lib/glob-overlap";

describe("overlaps (STRICT)", () => {
  test("differing literal segments are disjoint", () => {
    expect(overlaps("src/db/schema.ts", "src/api/users.ts")).toBe(false);
  });

  test("recursive wildcard overlaps a specific file under it", () => {
    expect(overlaps("src/db/**", "src/db/schema.ts")).toBe(true);
  });

  test("broad wildcard overlaps a nested file", () => {
    expect(overlaps("src/**", "src/api/users.ts")).toBe(true);
  });

  test("single-segment star does not reach into subdirectories", () => {
    expect(overlaps("src/*.ts", "src/db/schema.ts")).toBe(false);
  });

  test("identical globs overlap", () => {
    expect(overlaps("src/db/**", "src/db/**")).toBe(true);
  });

  test("in-segment star intersection", () => {
    expect(overlaps("src/*.ts", "src/schema.ts")).toBe(true);
    expect(overlaps("src/*.ts", "src/schema.sql")).toBe(false);
  });

  test("? matches one char within a segment", () => {
    expect(overlaps("src/a?.ts", "src/ab.ts")).toBe(true);
    expect(overlaps("src/a?.ts", "src/abc.ts")).toBe(false);
  });

  test("** spanning multiple segments", () => {
    expect(overlaps("a/**/z.ts", "a/x/y/z.ts")).toBe(true);
    expect(overlaps("a/**/z.ts", "a/x/y/q.ts")).toBe(false);
  });

  test("is symmetric", () => {
    const pairs: Array<[string, string]> = [
      ["src/db/**", "src/db/schema.ts"],
      ["src/db/schema.ts", "src/api/users.ts"],
      ["src/*.ts", "src/db/schema.ts"],
      ["a/**/z.ts", "a/x/y/z.ts"],
    ];
    for (const [a, b] of pairs) {
      expect(overlaps(a, b)).toBe(overlaps(b, a));
    }
  });
});

describe("scopesOverlap", () => {
  test("true when any pair overlaps", () => {
    expect(scopesOverlap(["src/api/**"], ["src/db/**", "src/api/users.ts"])).toBe(true);
  });

  test("false when all pairs are disjoint", () => {
    expect(scopesOverlap(["src/api/**"], ["src/db/**", "migrations/*.sql"])).toBe(false);
  });

  test("an unconfined (empty) scope conflicts with any confined sibling", () => {
    // one side unconfined → could write into the other's lane → overlap
    expect(scopesOverlap([], ["src/**"])).toBe(true);
    expect(scopesOverlap(["src/**"], [])).toBe(true);
    // both unconfined → legacy trust model, treated as non-overlapping
    expect(scopesOverlap([], [])).toBe(false);
  });
});
