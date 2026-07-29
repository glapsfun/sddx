// Migrating a repository off the retired plugin distribution.
//
// The promise made in docs/how-to/migrate-from-plugin.md is that `.sddx/` is
// project state and survives untouched — including the receipt chain, which is
// the one thing a user cannot reconstruct if it breaks.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { verifyChain } from "../src/lib/receipt";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, GRAPH_HEADER_LINES, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

/** Every file under `.sddx/`, so "untouched" can be asserted exactly. */
function sddxState(root: string): Record<string, string> {
  const base = join(root, ".sddx");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[relative(base, abs)] = readFileSync(abs, "utf8");
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/** The hook command the plugin registered, verbatim. Assembled rather than
 * written inline so the literal `${…}` never reads as a template placeholder. */
const PLUGIN_ERA_HOOK = `"\${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "\${CLAUDE_PLUGIN_ROOT}/dist/hooks.mjs" session-start`;

const SPEC = `task: deliver the widget
success_criteria:
  - "the artifact exists"
scope:
  - "part-a/**"
oracle:
  type: command
  run: "test -f part-a/out.txt"
  expect: exit 0
`;

/**
 * A repository as a plugin user would have left it: real lifecycle state from
 * a completed run, plus the plugin-era artifacts sddx no longer ships.
 */
function pluginEraRepo(): { root: string; worktree: string; id: string } {
  const { clone: root } = fixtureClone();

  mkdirSync(join(root, "specs"), { recursive: true });
  write(root, "specs/a.yaml", SPEC);
  write(
    root,
    "graph.yaml",
    `${[...GRAPH_HEADER_LINES, "goal: ship the widget", "tasks:", "  - alias: a", "    spec: specs/a.yaml"].join("\n")}\n`,
  );
  expect(cli(root, "graph", "approve", "--graph", "graph.yaml").status).toBe(0);
  const created = cli(root, "graph", "create", "--graph", "graph.yaml", "--output", "json");
  expect(created.status).toBe(0);
  const id = (JSON.parse(created.stdout).data as { taskIds: string[] }).taskIds[0] as string;

  const wt = join(root, ".sddx-worktrees", id);
  expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
  fakeRedCheck(wt, id);
  mkdirSync(join(wt, "part-a"), { recursive: true });
  writeFileSync(join(wt, "part-a", "out.txt"), "done\n");
  expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
  expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
  expect(cli(wt, "verify", id).status).toBe(0);

  // Plugin-era leftovers: a marketplace manifest and plugin-root hooks.
  write(root, ".claude-plugin/marketplace.json", '{"name":"sddx"}\n');
  write(
    root,
    ".claude/settings.json",
    `${JSON.stringify(
      {
        model: "opus",
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: PLUGIN_ERA_HOOK,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, worktree: wt, id };
}

describe("migrating a plugin-era repository", () => {
  test("doctor detects the legacy install and prescribes the order", () => {
    const { root } = pluginEraRepo();
    const r = cli(root, "doctor", "--output", "json");
    const checks = (
      JSON.parse(r.stdout).data as { checks: Array<{ id: string; status: string; fix?: string }> }
    ).checks;
    const legacy = checks.find((c) => c.id === "legacy-plugin")!;
    expect(legacy.status).toBe("warn");
    // init and verify come before removal — the whole point of the ordering
    expect(legacy.fix).toContain("sddx init --adapter claude");
    expect(legacy.fix).toContain("sddx doctor");
  });

  test("init leaves every byte of existing .sddx state alone", () => {
    const { root, worktree } = pluginEraRepo();
    const before = sddxState(worktree);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);

    expect(sddxState(worktree)).toEqual(before);
  });

  test("the receipt chain still validates after migrating", () => {
    const { root, worktree, id } = pluginEraRepo();
    expect(verifyChain(worktree)).toEqual([]);

    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);

    // the chain, the receipt, and audit all survive the boundary
    expect(verifyChain(worktree)).toEqual([]);
    expect(cli(worktree, "audit").status).toBe(0);
    const receipt = JSON.parse(
      readFileSync(join(worktree, ".sddx/receipts", `${id}.json`), "utf8"),
    );
    expect(receipt.verdict).toBe("pass");
  });

  test("the user's own Claude settings survive the merge", () => {
    const { root } = pluginEraRepo();
    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);

    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.model).toBe("opus");

    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((e) => e.hooks.map((h) => h.command));
    // the new registrations are in...
    expect(commands.some((c) => c === "sddx hook session-start")).toBe(true);
    // ...and the plugin-era entry is replaced rather than duplicated, because
    // it too carried the sddx marker
    expect(commands.filter((c) => c.includes("session-start"))).toHaveLength(1);
  });

  test("source files and the plugin leftovers are not touched by init", () => {
    const { root } = pluginEraRepo();
    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);
    // sddx never removes a plugin on the user's behalf
    expect(existsSync(join(root, ".claude-plugin/marketplace.json"))).toBe(true);
    expect(readFileSync(join(root, "specs/a.yaml"), "utf8")).toBe(SPEC);
  });
});
