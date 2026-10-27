import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOf, checkCoverage, renderReport } from "../scripts/spec-coverage";
import { repoRoot } from "./helpers";

const SPEC = `# Spec Delta

## ADDED Requirements

### Requirement: Export
The system SHALL export.

#### Scenario: Successful export
- **WHEN** x
- **THEN** y

#### Scenario: Empty export
- **WHEN** x
- **THEN** y
`;

// Built at runtime so this file's own source holds no literal links for the
// real coverage run to report as dangling.
const FN = ["scen", "ario"].join("");
const link = (capability: string, name: string): string =>
  `${FN}("${capability}", "${name}", () => {});\n`;

function fixture(testBody: string, opts: { archived?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "sddx-coverage-"));
  const specDir = join(root, "openspec", "changes", "demo", "specs", "data", "export");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "spec.md"), SPEC);
  if (opts.archived) {
    const archived = join(root, "openspec", "changes", "archive", "old", "specs", "gone");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "spec.md"), "#### Scenario: Archived only\n");
  }
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "demo.test.ts"), testBody);
  return root;
}

describe("spec-coverage", () => {
  test("capability keeps nested spec paths", () => {
    expect(capabilityOf(join("openspec", "specs", "identity", "user-auth", "spec.md"))).toBe(
      "identity/user-auth",
    );
  });

  test("every scenario linked and no dangling link passes", () => {
    const root = fixture(
      link("data/export", "Successful export") +
        `${FN}(\n  "data/export",\n  "Empty export",\n  () => {},\n);\n`,
    );
    const r = checkCoverage(root);
    expect(r.scenarios).toHaveLength(2);
    expect(r.unlinked).toEqual([]);
    expect(r.dangling).toEqual([]);
  });

  test("an unlinked scenario is reported with its location", () => {
    const root = fixture(link("data/export", "Successful export"));
    const r = checkCoverage(root);
    expect(r.unlinked.map((s) => s.name)).toEqual(["Empty export"]);
    expect(r.unlinked[0]!.line).toBe(12);
    expect(renderReport(r)).toContain("unlinked  [data/export] Empty export");
  });

  test("a link to a scenario that does not exist is dangling", () => {
    const root = fixture(
      link("data/export", "Successful export") +
        link("data/export", "Empty export") +
        link("data/export", "Renamed away"),
    );
    const r = checkCoverage(root);
    expect(r.dangling.map((l) => l.name)).toEqual(["Renamed away"]);
    expect(r.dangling[0]!.line).toBe(3);
  });

  test("archived changes are not counted", () => {
    const root = fixture(
      link("data/export", "Successful export") + link("data/export", "Empty export"),
      { archived: true },
    );
    expect(checkCoverage(root).scenarios.map((s) => s.name)).not.toContain("Archived only");
  });

  test("the CLI exits 1 on a gap and 0 when complete", () => {
    const script = join(repoRoot, "scripts", "spec-coverage.ts");
    const gap = fixture(link("data/export", "Successful export"));
    expect(spawnSync("bun", [script], { cwd: gap, encoding: "utf8" }).status).toBe(1);
    const full = fixture(
      link("data/export", "Successful export") + link("data/export", "Empty export"),
    );
    expect(spawnSync("bun", [script], { cwd: full, encoding: "utf8" }).status).toBe(0);
  });

  test("--if-present skips explicitly when the checkout has no specs", () => {
    const empty = mkdtempSync(join(tmpdir(), "sddx-coverage-empty-"));
    const script = join(repoRoot, "scripts", "spec-coverage.ts");
    const r = spawnSync("bun", [script, "--if-present"], { cwd: empty, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipped");
    const gap = fixture(link("data/export", "Successful export"));
    expect(spawnSync("bun", [script, "--if-present"], { cwd: gap }).status).toBe(1);
  });

  test("the CLI fails closed when no spec exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "sddx-coverage-empty-"));
    const script = join(repoRoot, "scripts", "spec-coverage.ts");
    const r = spawnSync("bun", [script], { cwd: empty, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no spec scenarios found");
  });
});
