// What the plugin's skills and agents promise the CLI and the harness, checked
// without running a model: every command they name exists, skill text names a
// harness's tools only in that harness's mapping file, and agents declare their tools.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { frontmatterValue } from "../scripts/token-budget";
import { CLI } from "./helpers";

export const SKILLS = ["using-sddx", "brainstorm", "plan", "execute", "review", "finish", "debug"];
export const AGENTS = ["worker", "critic"];
export const MAPPING_FILE = join("skills", "using-sddx", "references", "claude-code.md");
export const CODEX_MAPPING_FILE = join("skills", "using-sddx", "references", "codex.md");

/** Commands `sddx --help` lists: "plan check", "verify", "task phase", ... */
export function knownCommands(): Set<string> {
  const help = spawnSync("bun", [CLI, "--help"], { encoding: "utf8" }).stdout;
  const out = new Set<string>();
  for (const line of help.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "sddx" || !words[1]) continue;
    out.add(/^[a-z][a-z-]*$/.test(words[2] ?? "") ? `${words[1]} ${words[2]}` : words[1]);
  }
  return out;
}

/** Inline code spans and fenced code blocks: where a skill writes a command. */
function codeText(markdown: string): string {
  // a fence may be indented, as it is inside a list item
  const fences = [...markdown.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1/gm)].map(
    (m) => m[2],
  );
  const prose = markdown.replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1/gm, "");
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fences, ...spans].join("\n");
}

/** Each `sddx <command> [<subcommand>]` written in code, as the CLI would parse it. */
export function namedCommands(markdown: string, known: Set<string>): string[] {
  const groups = new Set([...known].filter((c) => c.includes(" ")).map((c) => c.split(" ")[0]));
  const out: string[] = [];
  for (const m of codeText(markdown).matchAll(
    /(?:^|[\s;&|(!])sddx[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/gm,
  )) {
    const [, first = "", second] = m;
    out.push(groups.has(first) && second ? `${first} ${second}` : first);
  }
  return out;
}

const CLAUDE_TOOLS = /\b(TodoWrite|AskUserQuestion|subagent_type)\b|\b(Agent|Task|Skill) tool\b/g;
const CODEX_TOOLS = /\b(spawn_agent|wait_agent|update_plan|request_user_input|fork_turns)\b/g;

const toolsIn = (markdown: string, tools: RegExp): string[] =>
  [...markdown.matchAll(tools)].map((m) => m[0]);

/** Claude Code and Codex tool names in a piece of skill text. */
export const harnessToolsIn = (markdown: string): string[] => [
  ...toolsIn(markdown, CLAUDE_TOOLS),
  ...toolsIn(markdown, CODEX_TOOLS),
];

function markdownUnder(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(relative(root, p));
    }
  };
  walk(base);
  return out.sort();
}

/** Every broken promise in a plugin root, one line each, naming the file. */
export function contractViolations(root: string, known = knownCommands()): string[] {
  const out: string[] = [];
  for (const file of [...markdownUnder(root, "skills"), ...markdownUnder(root, "agents")]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const cmd of namedCommands(text, known)) {
      if (!known.has(cmd))
        out.push(`${file}: names \`sddx ${cmd}\`, which sddx --help does not list`);
    }
    if (!file.startsWith("skills")) continue;
    if (file !== MAPPING_FILE) {
      for (const tool of new Set(toolsIn(text, CLAUDE_TOOLS))) {
        out.push(`${file}: names the Claude Code tool ${tool}; move it to ${MAPPING_FILE}`);
      }
    }
    if (file !== CODEX_MAPPING_FILE) {
      for (const tool of new Set(toolsIn(text, CODEX_TOOLS))) {
        out.push(`${file}: names the Codex tool ${tool}; move it to ${CODEX_MAPPING_FILE}`);
      }
    }
  }
  return out;
}

/** An agent's `tools`, from a comma-separated value or a YAML list. */
export function agentTools(markdown: string): string[] | null {
  const inline = frontmatterValue(markdown, "tools");
  if (inline === null) return null;
  if (inline !== "") return inline.split(/[,\s]+/).filter(Boolean);
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  const after = fm.split("\n").slice(fm.split("\n").findIndex((l) => l.startsWith("tools:")) + 1);
  const items: string[] = [];
  for (const l of after) {
    const m = /^\s*-\s*(\S+)/.exec(l);
    if (!m) break;
    items.push(m[1] as string);
  }
  return items;
}
