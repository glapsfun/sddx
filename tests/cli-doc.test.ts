import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, sddx } from "./helpers";

const doc = readFileSync(join(repoRoot, "docs", "reference", "cli.md"), "utf8");
const usage = (/```\nusage:\n([\s\S]*?)```/.exec(doc)?.[1] ?? "")
  .split("\n")
  .filter((l) => l.startsWith("  sddx "))
  .map((l) => l.trim());

/** `sddx plan check <spec.md>` -> ["plan", "check"]; `sddx verify <id>` -> ["verify"]. */
const commandOf = (line: string): string[] =>
  line
    .split(/\s+/)
    .slice(1, 3)
    .filter((w, i) => i === 0 || /^[a-z][a-z-]*$/.test(w));

const testSources = readdirSync(join(repoRoot, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => readFileSync(join(repoRoot, "tests", f), "utf8"))
  .join("\n");

describe("docs/reference/cli.md", () => {
  test("documents a usage block", () => {
    expect(usage.length).toBeGreaterThan(20);
  });

  test("every documented command line is what `sddx --help` prints", () => {
    const help = sddx(repoRoot, "--help")
      .stdout.split("\n")
      .map((l) => l.trim());
    for (const line of usage) expect(help).toContain(line);
  });

  for (const line of usage) {
    const words = commandOf(line);
    test(`\`sddx ${words.join(" ")}\` is exercised by a test`, () => {
      const args = words.map((w) => `"${w}"`).join(",\\s*");
      const call = new RegExp(`(?:sddx\\(|\\[CLI,)[^)\\]]*?${args}`);
      expect(call.test(testSources)).toBe(true);
    });
  }
});
