// Always-on token budget: what Claude Code loads before any skill is invoked is
// each skill's and agent's frontmatter name + description. ceil(chars/4) is a
// deliberate dependency-free proxy — the gate catches growth, not exact counts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BUDGET = 500;

export interface BudgetItem {
  file: string;
  chars: number;
  tokens: number;
}

export interface BudgetReport {
  items: BudgetItem[];
  total: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** name/description values from the leading `---` frontmatter block, if any. */
function alwaysOnText(markdown: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!fm) return "";
  const wanted: string[] = [];
  for (const line of fm[1]!.split("\n")) {
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m) wanted.push(m[2]!);
  }
  return wanted.join("");
}

function alwaysOnFiles(root: string): string[] {
  const files: string[] = [];
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const skill = join("skills", name, "SKILL.md");
      if (existsSync(join(root, skill))) files.push(skill);
    }
  }
  const agentsDir = join(root, "agents");
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).sort()) {
      if (name.endsWith(".md")) files.push(join("agents", name));
    }
  }
  return files;
}

export function measureAlwaysOn(root: string): BudgetReport {
  const items: BudgetItem[] = alwaysOnFiles(root).map((file) => {
    const text = alwaysOnText(readFileSync(join(root, file), "utf8"));
    return { file, chars: text.length, tokens: estimateTokens(text) };
  });
  return { items, total: items.reduce((sum, i) => sum + i.tokens, 0) };
}

if (import.meta.main) {
  const report = measureAlwaysOn(process.argv[2] ?? process.cwd());
  for (const item of report.items) console.log(`${String(item.tokens).padStart(5)}  ${item.file}`);
  console.log(`${String(report.total).padStart(5)}  total (budget ${BUDGET})`);
  process.exit(report.total <= BUDGET ? 0 : 1);
}
