import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const EXAMPLE = /<!-- spec-example: (valid|invalid) -->\n````markdown\n([\s\S]*?)\n````/g;
const examplesIn = (page: string) =>
  [...readFileSync(join(repoRoot, "docs", "reference", page), "utf8").matchAll(EXAMPLE)].map(
    (m) => ({ kind: m[1], text: m[2] ?? "" }),
  );
const examples = examplesIn("spec-reference.md");

describe("docs/reference/verification.md", () => {
  test("is linked from the CLI reference", () => {
    const cli = readFileSync(join(repoRoot, "docs", "reference", "cli.md"), "utf8");
    expect(cli).toContain("(verification.md)");
  });

  for (const [i, e] of examplesIn("verification.md").entries()) {
    test(`example ${i + 1} is ${e.kind} according to sddx spec check`, () => {
      const dir = mkdtempSync(join(tmpdir(), "sddx-verifydoc-"));
      writeFileSync(join(dir, "example.md"), `${e.text}\n`);
      const r = spawnSync("bun", [CLI, "spec", "check", "example.md"], { cwd: dir });
      expect(r.status).toBe(e.kind === "valid" ? 0 : 1);
    });
  }
});

describe("docs/reference/spec-reference.md examples", () => {
  test("the page has both valid and invalid examples", () => {
    expect(examples.some((e) => e.kind === "valid")).toBe(true);
    expect(examples.some((e) => e.kind === "invalid")).toBe(true);
  });

  for (const [i, e] of examples.entries()) {
    test(`example ${i + 1} is ${e.kind} according to sddx spec check`, () => {
      const dir = mkdtempSync(join(tmpdir(), "sddx-specdoc-"));
      writeFileSync(join(dir, "example.md"), `${e.text}\n`);
      const r = spawnSync("bun", [CLI, "spec", "check", "example.md"], { cwd: dir });
      expect(r.status).toBe(e.kind === "valid" ? 0 : 1);
    });
  }
});
