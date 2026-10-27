import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALWAYS_ON_BUDGET,
  measureAlwaysOn,
  overBudget,
  ROUTER_BUDGET,
} from "../scripts/token-budget";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

/** A plugin root with one skill and one agent carrying the given descriptions. */
function fixturePlugin(skillDesc: string, agentDesc: string): string {
  const root = mkdtempSync(join(tmpdir(), "budget-"));
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "agents"));
  writeFileSync(
    join(root, "skills", "demo", "SKILL.md"),
    `---\nname: demo\ndescription: ${skillDesc}\n---\n\nBody text is loaded on use and must not count.\n`,
  );
  writeFileSync(
    join(root, "agents", "helper.md"),
    `---\nname: helper\ndescription: ${agentDesc}\ntools: Read\n---\n\nAgent body, also not always-on.\n`,
  );
  return root;
}

describe("always-on budget", () => {
  test("counts frontmatter name and description, not the body or other keys", () => {
    const report = measureAlwaysOn(fixturePlugin("short", "short"));
    expect(report.items.map((i) => i.file)).toEqual([
      join("agents", "helper.md"),
      join("skills", "demo", "SKILL.md"),
    ]);
    // "demo" + "short" = 9 chars, "helper" + "short" = 11 chars
    expect(report.items.map((i) => i.tokens)).toEqual([3, 3]);
  });

  test("a folded description is measured in full", () => {
    const root = fixturePlugin("short", "short");
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      `---\nname: demo\ndescription: >-\n  ${"x".repeat(396)}\n---\n\nbody\n`,
    );
    const demo = measureAlwaysOn(root).items.find((i) => i.file.includes("demo"));
    expect(demo?.tokens).toBe(100);
  });

  test("CRLF line endings are measured like LF", () => {
    const root = fixturePlugin("short", "short");
    for (const f of [join(root, "skills", "demo", "SKILL.md"), join(root, "agents", "helper.md")]) {
      writeFileSync(f, readFileSync(f, "utf8").replaceAll("\n", "\r\n"));
    }
    expect(measureAlwaysOn(root).items.map((i) => i.tokens)).toEqual([3, 3]);
  });

  scenario("workflow-skills", "Growth over budget fails", () => {
    // "demo" (4 chars) + 2,396 chars = 600 tokens, "helper" + "x" = 2 tokens
    const root = fixturePlugin("x".repeat(2396), "x");
    const report = measureAlwaysOn(root);
    expect(report.total).toBe(ALWAYS_ON_BUDGET + 2);
    expect(overBudget(report)).toBe(true);

    const r = spawnSync("bun", [join(repoRoot, "scripts", "token-budget.ts"), root], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`  600  ${join("skills", "demo", "SKILL.md")}`);
    expect(r.stdout).toContain(`    2  ${join("agents", "helper.md")}`);
    expect(r.stdout).toContain(`over budget`);
  });

  test("the budgets are the ones the workflow-skills spec sets", () => {
    expect(ALWAYS_ON_BUDGET).toBe(600);
    expect(ROUTER_BUDGET).toBe(1500);
  });
});
