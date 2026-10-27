import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HooksFile = { hooks: Record<string, MatcherGroup[]> };

const hooksText = (): string => readFileSync(join(repoRoot, "hooks", "hooks.json"), "utf8");
const hooksFile = (): HooksFile => JSON.parse(hooksText()) as HooksFile;

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder Claude Code expands
const LAUNCHER = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook" ';
const handlerOf = (command: string): string => {
  if (!command.startsWith(LAUNCHER)) throw new Error(`not launched through run-hook: ${command}`);
  return command.slice(LAUNCHER.length);
};

/** "Event matcher" -> handlers, in registration order. */
function registrations(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(hooksFile().hooks)) {
    for (const g of groups) {
      const key = g.matcher ? `${event} ${g.matcher}` : event;
      out[key] = [...(out[key] ?? []), ...g.hooks.map((h) => handlerOf(h.command))];
    }
  }
  return out;
}

const EXPECTED_REGISTRATIONS: Record<string, string[]> = {
  "SessionStart startup|clear|compact": ["session-start"],
  "PreToolUse Bash": ["approval-gate", "bash-gate"],
  "PreToolUse Edit|Write|MultiEdit|NotebookEdit": ["approval-gate", "tdd-gate"],
  "PostToolUse Bash": ["record-test"],
  Stop: ["stop-gate"],
  SubagentStop: ["stop-gate"],
};

describe("hooks/hooks.json", () => {
  scenario("claude-hooks", "Registration table", () => {
    expect(registrations()).toEqual(EXPECTED_REGISTRATIONS);
  });

  scenario("claude-hooks", "Timeouts present", () => {
    for (const groups of Object.values(hooksFile().hooks)) {
      for (const h of groups.flatMap((g) => g.hooks)) {
        expect(h.type).toBe("command");
        expect(h.timeout).toBe(handlerOf(h.command) === "approval-gate" ? 30 : 10);
      }
    }
  });

  scenario("claude-plugin", "Hook commands resolve", () => {
    const sources = [hooksText()];
    for (const dir of ["skills", "agents"]) {
      const walk = (d: string): void => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".md")) sources.push(readFileSync(p, "utf8"));
        }
      };
      walk(join(repoRoot, dir));
    }
    const refs = sources.flatMap((s) =>
      [...s.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"'`)\\]+)/g)].map((m) => m[1] as string),
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const rel of new Set(refs)) {
      const path = join(repoRoot, rel);
      expect(existsSync(path)).toBe(true);
      accessSync(path, constants.X_OK);
    }
  });

  test("the registration table in docs/reference/hooks.md matches hooks/hooks.json", () => {
    const doc = readFileSync(join(repoRoot, "docs", "reference", "hooks.md"), "utf8");
    const section = doc.split("## Registration in Claude Code")[1]?.split(/\n#{2,3} /)[0] ?? "";
    const ticks = (cell: string): string[] =>
      [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    const documented: Record<string, string[]> = {};
    const timeouts: Record<string, number[]> = {};
    for (const line of section.split("\n").filter((l) => l.startsWith("| `"))) {
      const [event, matcher, handlers, timeout] = line
        .split(" | ")
        .map((c) => c.replace(/^\| |\s*\|$/g, ""));
      const matchers = ticks(matcher ?? "");
      const key =
        matchers.length > 0
          ? `${ticks(event ?? "")[0]} ${matchers.join("|")}`
          : `${ticks(event ?? "")[0]}`;
      documented[key] = ticks(handlers ?? "");
      timeouts[key] = [...(timeout ?? "").matchAll(/(\d+) s/g)].map((m) => Number(m[1]));
    }
    expect(documented).toEqual(registrations());
    for (const [event, groups] of Object.entries(hooksFile().hooks)) {
      for (const g of groups) {
        const key = g.matcher ? `${event} ${g.matcher}` : event;
        expect(timeouts[key]).toEqual(g.hooks.map((h) => h.timeout as number));
      }
    }
  });
});
