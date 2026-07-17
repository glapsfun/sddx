import { describe, expect, test } from "bun:test";
import { BUILTIN_EXEMPT_GLOBS, BUILTIN_TEST_GLOBS, classify } from "../src/lib/classify";

describe("classify", () => {
  test("implementation by default", () => {
    expect(classify("src/api.ts", [])).toEqual({ rule: "implementation", pattern: null });
  });

  test("every built-in exempt glob has a matching sample", () => {
    const samples: Record<string, string> = {
      ".sddx/**": ".sddx/tasks/x.json",
      "docs/**": "docs/guide/intro.txt",
      "**/*.md": "deep/nested/README.md",
      "package.json": "package.json",
      "tsconfig.json": "tsconfig.json",
      ".github/**": ".github/workflows/ci.yml",
      "openspec/**": "openspec/changes/x/meta.json",
      ".claude/**": ".claude/settings.json",
    };
    for (const glob of BUILTIN_EXEMPT_GLOBS) {
      const sample = samples[glob];
      expect(sample).toBeDefined();
      expect(classify(sample as string, [])).toEqual({ rule: "exempt", pattern: glob });
    }
  });

  test("every built-in test glob has a matching sample", () => {
    const samples: Record<string, string> = {
      "**/*.test.*": "src/api.test.ts",
      "**/*.spec.*": "src/api.spec.tsx",
      "**/*_test.*": "pkg/thing_test.go",
      "**/test_*.py": "pkg/test_api.py",
      "tests/**": "tests/health.ts",
      "test/**": "test/health.ts",
      "__tests__/**": "__tests__/api.js",
      "spec/**": "spec/api_spec.rb",
    };
    for (const glob of BUILTIN_TEST_GLOBS) {
      const sample = samples[glob];
      expect(sample).toBeDefined();
      expect(classify(sample as string, [])).toEqual({ rule: "test", pattern: glob });
    }
  });

  test("allow beats everything, by exact repo-relative path", () => {
    expect(classify("src/migration.sql", ["src/migration.sql"]).rule).toBe("allow");
    expect(classify("./docs/x.md", ["docs/x.md"]).rule).toBe("allow");
    expect(classify("src/migration.sql", ["src/other.sql"]).rule).toBe("implementation");
  });

  test("exempt beats test for overlapping paths", () => {
    // .md under tests/ — exempt list is consulted first
    expect(classify("tests/notes.md", []).rule).toBe("exempt");
  });

  test("userConfig globs merge after built-ins", () => {
    expect(classify("checks/health.ts", [], { testGlobs: "checks/**" }).rule).toBe("test");
    expect(classify("generated/api.ts", [], { exemptGlobs: "generated/** vendor/**" }).rule).toBe(
      "exempt",
    );
    expect(classify("vendor/lib.js", [], { exemptGlobs: "generated/** vendor/**" }).rule).toBe(
      "exempt",
    );
  });

  test("backslash-separated paths are normalized before matching", () => {
    expect(classify("tests\\api.test.ts", []).rule).toBe("test");
    expect(classify(".\\docs\\guide.txt", []).rule).toBe("exempt");
  });

  test("empty and whitespace userConfig strings are harmless", () => {
    expect(classify("src/a.ts", [], { testGlobs: "  ", exemptGlobs: "" }).rule).toBe(
      "implementation",
    );
  });
});
