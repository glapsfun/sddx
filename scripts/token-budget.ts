// The two context costs the plugin's skills impose, measured on every test run.
// Always-on: what a harness loads before any skill runs, each skill's and
// agent's frontmatter name and description. Router: what session start injects
// into every opted-in session, the `using-sddx` body plus its Claude Code tool
// mapping. ceil(chars/4) is a deliberate dependency-free proxy: the gate catches
// growth, not exact counts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatterValue, withoutFrontmatter } from "../src/lib/frontmatter";

export { frontmatterValue, withoutFrontmatter };

export const ALWAYS_ON_BUDGET = 600;
export const ROUTER_BUDGET = 1500;

export interface BudgetItem {
  file: string;
  chars: number;
  tokens: number;
}

export interface BudgetReport {
  items: BudgetItem[];
  total: number;
  budget: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function skillAndAgentFiles(root: string): string[] {
  const files: string[] = [];
  const agents = join(root, "agents");
  if (existsSync(agents)) {
    for (const name of readdirSync(agents).sort()) {
      if (name.endsWith(".md")) files.push(join("agents", name));
    }
  }
  const skills = join(root, "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills).sort()) {
      if (existsSync(join(skills, name, "SKILL.md"))) files.push(join("skills", name, "SKILL.md"));
    }
  }
  return files;
}

const item = (file: string, text: string): BudgetItem => ({
  file,
  chars: text.length,
  tokens: estimateTokens(text),
});

const report = (items: BudgetItem[], budget: number): BudgetReport => ({
  items,
  total: items.reduce((sum, i) => sum + i.tokens, 0),
  budget,
});

export function measureAlwaysOn(root: string): BudgetReport {
  return report(
    skillAndAgentFiles(root).map((file) => {
      const md = readFileSync(join(root, file), "utf8");
      return item(
        file,
        `${frontmatterValue(md, "name") ?? ""}${frontmatterValue(md, "description") ?? ""}`,
      );
    }),
    ALWAYS_ON_BUDGET,
  );
}

export const ROUTER_FILES = [
  join("skills", "using-sddx", "SKILL.md"),
  join("skills", "using-sddx", "references", "claude-code.md"),
];

/** Throws when a router file is missing: an absent router is not a cheap one. */
export function measureRouter(root: string): BudgetReport {
  return report(
    ROUTER_FILES.map((file) =>
      item(file, withoutFrontmatter(readFileSync(join(root, file), "utf8"))),
    ),
    ROUTER_BUDGET,
  );
}

export const overBudget = (r: BudgetReport): boolean => r.total > r.budget;

export function renderReport(label: string, r: BudgetReport): string {
  const lines = r.items.map((i) => `${String(i.tokens).padStart(5)}  ${i.file}`);
  const verdict = overBudget(r) ? "over budget" : "within budget";
  lines.push(`${String(r.total).padStart(5)}  ${label} total, budget ${r.budget}: ${verdict}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const reports: Array<[string, BudgetReport]> = [["always-on", measureAlwaysOn(root)]];
  if (ROUTER_FILES.every((f) => existsSync(join(root, f)))) {
    reports.push(["router", measureRouter(root)]);
  }
  console.log(reports.map(([label, r]) => renderReport(label, r)).join("\n\n"));
  process.exit(reports.some(([, r]) => overBudget(r)) ? 1 : 0);
}
