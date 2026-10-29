// The user documentation is checked against the CLI it documents: install
// steps start from the plugin, every documented command exists, removed v5
// workflows stay in the migration guide, and the team settings snippet parses.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";
import { knownCommands } from "./skill-contract";

const known = knownCommands();
const MIGRATION_GUIDE = join("docs", "how-to", "migrate-to-v6.md");

function markdownIn(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    const p = join(base, e.name);
    if (e.isDirectory()) out.push(...markdownIn(root, relative(root, p)));
    else if (e.name.endsWith(".md")) out.push(relative(root, p));
  }
  return out.sort();
}

/** README plus the tutorials, how-to guides and explanations. */
const userDocs = (root: string): string[] => [
  ...(existsSync(join(root, "README.md")) ? ["README.md"] : []),
  ...["tutorials", "how-to", "explanation"].flatMap((d) => markdownIn(root, join("docs", d))),
];

/** `sddx ...` lines in fenced blocks, skipping blocks the migration guide marks sddx5. */
function documentedCommands(file: string, markdown: string): string[] {
  const groups = new Set([...known].filter((c) => c.includes(" ")).map((c) => c.split(" ")[0]));
  const out: string[] = [];
  for (const m of markdown.matchAll(/^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1/gm)) {
    const info = m[2] ?? "";
    if (file === MIGRATION_GUIDE && /\bsddx5\b/.test(info)) continue;
    for (const line of (m[3] ?? "").split("\n")) {
      const words = line
        .trim()
        .replace(/^[$!]\s+/, "")
        .split(/\s+/);
      if (words[0] !== "sddx" || !/^[a-z][a-z0-9-]*$/.test(words[1] ?? "")) continue;
      const [, first = "", second] = words;
      const pair = second && /^[a-z][a-z-]*$/.test(second) ? `${first} ${second}` : null;
      // a group needs its subcommand; an unknown command is named with it too
      out.push(pair && (groups.has(first) || !known.has(first)) ? pair : first);
    }
  }
  return out;
}

export function staleCommands(root: string): string[] {
  const out: string[] = [];
  for (const file of userDocs(root)) {
    for (const cmd of documentedCommands(file, readFileSync(join(root, file), "utf8"))) {
      if (!known.has(cmd)) out.push(`${file}: sddx ${cmd}`);
    }
  }
  return out;
}

const REMOVED_TERMS = [
  "sddx init",
  "sddx sync",
  "sddx uninstall",
  "graph create",
  "graph approve",
  "intake check",
  "red-check",
  "templates/claude/",
];

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("user documentation", () => {
  scenario("user-docs", "A stale command is caught", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-"));
    mkdirSync(join(root, "docs", "tutorials"), { recursive: true });
    writeFileSync(
      join(root, "docs", "tutorials", "01-start.md"),
      "# Start\n\n```sh\nsddx spec check .sddx/specs/x.md\nsddx graph create --graph g.yaml\n```\n",
    );
    expect(staleCommands(root)).toEqual([
      `${join("docs", "tutorials", "01-start.md")}: sddx graph create`,
    ]);
  });

  test("the migration guide's sddx5 blocks are exempt, and only there", () => {
    const block = "```sh sddx5\nsddx red-check T1\n```\n";
    expect(documentedCommands(MIGRATION_GUIDE, block)).toEqual([]);
    expect(documentedCommands("README.md", block)).toEqual(["red-check"]);
  });

  scenario("user-docs", "Install commands present", () => {
    for (const file of [
      "README.md",
      "docs/tutorials/01-getting-started.md",
      "docs/how-to/install-sddx.md",
    ]) {
      const text = read(file);
      expect({ file, has: text.includes("/plugin marketplace add glapsfun/sddx") }).toEqual({
        file,
        has: true,
      });
      expect({ file, has: text.includes("/plugin install sddx@sddx") }).toEqual({
        file,
        has: true,
      });
      expect({ file, npmGlobal: /npm install -g/.test(text) }).toEqual({ file, npmGlobal: false });
    }
  });

  scenario("user-docs", "Codex install commands present", () => {
    for (const file of ["README.md", "docs/how-to/install-sddx.md"]) {
      const text = read(file);
      for (const command of [
        "codex plugin marketplace add glapsfun/sddx",
        "codex plugin add sddx@sddx",
      ]) {
        expect({ file, command, has: text.includes(command) }).toEqual({
          file,
          command,
          has: true,
        });
      }
    }
    expect(read("docs/how-to/install-sddx.md")).toContain("`/hooks`");
  });

  scenario("user-docs", "Codex troubleshooting entries", () => {
    const text = read(join("docs", "how-to", "troubleshoot-common-problems.md"));
    expect(text).toContain("`/hooks`");
    expect(text).toContain("escalation");
    expect(text).toMatch(/`![^`]*sddx plan approve[^`]*`/);
    expect(text).toContain("`codex exec`");
  });

  scenario("user-docs", "Shipped docs pass", () => {
    expect(staleCommands(repoRoot)).toEqual([]);
  });

  scenario("user-docs", "v5 commands outside the migration guide", () => {
    const offenders: string[] = [];
    for (const file of ["README.md", ...markdownIn(repoRoot, "docs")]) {
      if (file === MIGRATION_GUIDE) continue;
      const text = read(file);
      for (const term of REMOVED_TERMS) if (text.includes(term)) offenders.push(`${file}: ${term}`);
    }
    expect(offenders).toEqual([]);
    expect(existsSync(join(repoRoot, "docs", "how-to", "migrate-to-v4.md"))).toBe(false);
    expect(existsSync(join(repoRoot, "docs", "how-to", "migrate-from-plugin.md"))).toBe(false);
  });

  scenario("user-docs", "Team settings snippet is valid", () => {
    const guide = read(join("docs", "how-to", "share-sddx-with-a-team.md"));
    const block = /```json\n([\s\S]*?)```/.exec(guide)?.[1];
    expect(block).toBeDefined();
    const settings = JSON.parse(block as string) as {
      extraKnownMarketplaces: Record<string, { source: { source: string; repo: string } }>;
      enabledPlugins: Record<string, boolean>;
    };
    expect(settings.extraKnownMarketplaces.sddx?.source).toEqual({
      source: "github",
      repo: "glapsfun/sddx",
    });
    expect(settings.enabledPlugins["sddx@sddx"]).toBe(true);
  });
});
