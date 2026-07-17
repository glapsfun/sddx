// Ordered path classifier for the TDD gate: allow → exempt → test → implementation.
// First match wins; every decision names the rule that made it, for the block message
// and the audit trail.
import { globMatch } from "./glob";

export const BUILTIN_EXEMPT_GLOBS: readonly string[] = [
  ".sddx/**",
  "docs/**",
  "**/*.md",
  "package.json",
  "tsconfig.json",
  ".github/**",
  "openspec/**",
  ".claude/**",
];

export const BUILTIN_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "tests/**",
  "test/**",
  "__tests__/**",
  "spec/**",
];

export interface ClassifyConfig {
  /** Space-separated extra globs, per the manifest userConfig format. */
  testGlobs?: string;
  exemptGlobs?: string;
}

export interface Classification {
  rule: "allow" | "exempt" | "test" | "implementation";
  pattern: string | null;
}

const splitGlobs = (value?: string): string[] => (value ?? "").split(/\s+/).filter((g) => g !== "");

// Forward slashes only: Windows-separated inputs would silently match no glob,
// misclassifying test files as implementation.
export const normalizeRelPath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

export function classify(
  relPath: string,
  allow: readonly string[],
  config: ClassifyConfig = {},
): Classification {
  const path = normalizeRelPath(relPath);
  for (const entry of allow) {
    if (normalizeRelPath(entry) === path) return { rule: "allow", pattern: entry };
  }
  for (const pattern of [...BUILTIN_EXEMPT_GLOBS, ...splitGlobs(config.exemptGlobs)]) {
    if (globMatch(pattern, path)) return { rule: "exempt", pattern };
  }
  for (const pattern of [...BUILTIN_TEST_GLOBS, ...splitGlobs(config.testGlobs)]) {
    if (globMatch(pattern, path)) return { rule: "test", pattern };
  }
  return { rule: "implementation", pattern: null };
}
