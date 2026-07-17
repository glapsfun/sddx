import { describe, expect, test } from "bun:test";
import { globMatch } from "../src/lib/glob";

describe("globMatch", () => {
  test("literal segments", () => {
    expect(globMatch("package.json", "package.json")).toBe(true);
    expect(globMatch("package.json", "sub/package.json")).toBe(false);
  });

  test("* stays within a segment", () => {
    expect(globMatch("*.md", "README.md")).toBe(true);
    expect(globMatch("*.md", "docs/README.md")).toBe(false);
  });

  test("? matches one non-slash char", () => {
    expect(globMatch("a?.ts", "ab.ts")).toBe(true);
    expect(globMatch("a?.ts", "a/.ts")).toBe(false);
    expect(globMatch("a?.ts", "a.ts")).toBe(false);
  });

  test("trailing ** requires something beneath", () => {
    expect(globMatch("tests/**", "tests/health.test.ts")).toBe(true);
    expect(globMatch("tests/**", "tests/a/b/c.ts")).toBe(true);
    expect(globMatch("tests/**", "tests")).toBe(false);
    expect(globMatch("tests/**", "src/tests-not.ts")).toBe(false);
  });

  test("leading **/ matches zero or more directories", () => {
    expect(globMatch("**/*.test.*", "a.test.ts")).toBe(true);
    expect(globMatch("**/*.test.*", "src/deep/a.test.tsx")).toBe(true);
    expect(globMatch("**/*.test.*", "src/a.tests.ts")).toBe(false);
    expect(globMatch("**/test_*.py", "test_api.py")).toBe(true);
    expect(globMatch("**/test_*.py", "pkg/test_api.py")).toBe(true);
    expect(globMatch("**/test_*.py", "pkg/apitest_x.py")).toBe(false);
  });

  test("interior **", () => {
    expect(globMatch("a/**/b.ts", "a/b.ts")).toBe(true);
    expect(globMatch("a/**/b.ts", "a/x/y/b.ts")).toBe(true);
    expect(globMatch("a/**/b.ts", "a/x/c.ts")).toBe(false);
  });

  test("regex metacharacters are literal", () => {
    expect(globMatch("**/*_test.*", "pkg/thing_test.go")).toBe(true);
    expect(globMatch("a+b.ts", "a+b.ts")).toBe(true);
    expect(globMatch("a+b.ts", "aab.ts")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});
