import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET, measureAlwaysOn } from "../scripts/token-budget";
import { repoRoot } from "./helpers";

/** Minimal plugin root with one skill and one agent carrying the given descriptions. */
function fixturePlugin(skillDesc: string, agentDesc: string): string {
  const root = mkdtempSync(join(tmpdir(), "sddx-budget-"));
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "skills", "demo", "SKILL.md"),
    `---\nname: demo\ndescription: ${skillDesc}\n---\n\nBody text is lazy-loaded and must not count.\n`,
  );
  writeFileSync(
    join(root, "agents", "helper.md"),
    `---\nname: helper\ndescription: ${agentDesc}\n---\n\nAgent body, also not always-on.\n`,
  );
  return root;
}

describe("measureAlwaysOn", () => {
  test("is deterministic over an unchanged checkout", () => {
    const a = measureAlwaysOn(repoRoot);
    const b = measureAlwaysOn(repoRoot);
    expect(a.total).toBe(b.total);
    expect(a.items).toEqual(b.items);
  });

  test("counts frontmatter name and description, not body text", () => {
    const root = fixturePlugin("short", "short");
    const report = measureAlwaysOn(root);
    expect(report.items.map((i) => i.file).sort()).toEqual([
      "agents/helper.md",
      "skills/demo/SKILL.md",
    ]);
    // "namedemodescriptionshort" scale, never the multi-line bodies
    for (const item of report.items) expect(item.tokens).toBeLessThan(20);
  });

  test("growth is visible: +400 chars costs at least 100 estimated tokens", () => {
    const base = measureAlwaysOn(fixturePlugin("short", "short"));
    const grown = measureAlwaysOn(fixturePlugin(`short${"x".repeat(400)}`, "short"));
    expect(grown.total - base.total).toBeGreaterThanOrEqual(100);
  });

  test("always-on surface of this checkout fits the 500-token budget", () => {
    const report = measureAlwaysOn(repoRoot);
    const breakdown = report.items.map((i) => `${i.file}: ${i.tokens}`).join(", ");
    expect(BUDGET).toBe(500);
    expect(
      report.total,
      `over budget (${report.total} > ${BUDGET}): ${breakdown}`,
    ).toBeLessThanOrEqual(BUDGET);
  });
});

describe("session-start always-on cost", () => {
  test("injects no context in a repo without .sddx", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-plain-"));
    const r = spawnSync("bun", [join(repoRoot, "src/hooks.ts"), "session-start"], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify({ cwd }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const decision = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(decision.hookSpecificOutput).toBeUndefined();
    expect(decision.systemMessage).toBeUndefined();
  });
});
