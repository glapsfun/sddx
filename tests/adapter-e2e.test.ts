// The proof the whole change rests on: a repository initialized by
// `sddx init --adapter claude`, with NO marketplace plugin anywhere, runs the
// canonical lifecycle through to a verified, hash-chained receipt — and the TDD
// gate that fires is the one the adapter registered, invoked exactly as it
// wrote it into `.claude/settings.json`.
//
// Every hook here is driven through the REGISTERED COMMAND STRING rather than
// through a known-good path. That is the point: it tests what Claude Code would
// actually execute, so a wrong invocation cannot pass.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../src/lib/receipt";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, GRAPH_HEADER_LINES, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

interface HookEntry {
  matcher?: string;
  hooks: Array<{ command: string }>;
}

/** The commands the adapter registered for one event, verbatim. */
function registeredCommands(
  root: string,
  event: string,
): Array<{ matcher?: string; command: string }> {
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
    hooks: Record<string, HookEntry[]>;
  };
  return (settings.hooks[event] ?? []).flatMap((e) =>
    e.hooks.map((h) => ({ matcher: e.matcher, command: h.command })),
  );
}

/**
 * Runs a registered hook command the way the harness does: through a shell,
 * with the event JSON on stdin. Nothing is substituted — if the invocation the
 * adapter generated is wrong, this fails.
 */
function fireHook(
  root: string,
  command: string,
  event: unknown,
  extraPath?: string,
): { status: number; out: Record<string, unknown> } {
  const env = { ...process.env };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  const r = spawnSync(command, {
    cwd: root,
    input: JSON.stringify(event),
    encoding: "utf8",
    shell: true,
    env,
  });
  const raw = (r.stdout ?? "").trim();
  return { status: r.status ?? -1, out: raw === "" ? {} : JSON.parse(raw) };
}

const denyReason = (out: Record<string, unknown>): string | undefined =>
  (out.hookSpecificOutput as Record<string, string> | undefined)?.permissionDecisionReason;

const editEvent = (cwd: string, filePath: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: filePath },
  cwd,
});

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

/** A clone initialized with the Claude adapter, and no plugin in sight. */
function initialized(scope: "global" | "project"): string {
  const { clone } = fixtureClone();
  const args = ["init", "--yes", "--runtime", scope, "--adapter", "claude"];
  if (scope === "project") args.push("--package-manager", "npm");
  const r = cli(clone, ...args);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}${r.stdout}`);

  // The precondition the whole change asserts.
  expect(existsSync(join(clone, ".claude-plugin"))).toBe(false);
  return clone;
}

/**
 * Makes a project-pinned invocation actually resolvable.
 *
 * `npm exec --offline --no -- sddx` runs `node_modules/.bin/sddx`. Publishing
 * and installing the real package inside a test would need a registry, so the
 * local binary is a shim onto this checkout's CLI — the resolution path under
 * test is npm's, which is the part that could be wrong.
 */
function pinLocalBinary(root: string): void {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "node_modules", "@glapsfun", "sddx"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@glapsfun", "sddx", "package.json"),
    JSON.stringify({ name: "@glapsfun/sddx", version: "0.0.0-test", bin: { sddx: "cli.js" } }),
  );
  const shim = join(bin, "sddx");
  writeFileSync(shim, `#!/bin/sh\nexec bun ${CLI} "$@"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "fixture", devDependencies: { "@glapsfun/sddx": "0.0.0-test" } },
      null,
      2,
    ),
  );
}

function planOneNode(cwd: string): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  writeFileSync(join(cwd, "specs", "a.yaml"), SPEC);
  writeFileSync(
    join(cwd, "graph.yaml"),
    `${[...GRAPH_HEADER_LINES, "goal: ship the widget", "tasks:", "  - alias: a", "    spec: specs/a.yaml"].join("\n")}\n`,
  );
  return "graph.yaml";
}

function createRunHere(cwd: string): { id: string; goalId: string } {
  expect(cli(cwd, "graph", "approve", "--graph", "graph.yaml").status).toBe(0);
  const r = cli(cwd, "graph", "create", "--graph", "graph.yaml", "--output", "json");
  expect(r.status).toBe(0);
  const d = JSON.parse(r.stdout).data as { taskIds: string[]; goalId: string };
  return { id: d.taskIds[0] as string, goalId: d.goalId };
}

describe("guided flow, global runtime scope, no plugin", () => {
  test("runs to a verified, hash-chained receipt", () => {
    const root = initialized("global");
    planOneNode(root);
    const { id } = createRunHere(root);

    const wt = join(root, ".sddx-worktrees", id);
    expect(existsSync(wt)).toBe(true);

    expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, id);
    mkdirSync(join(wt, "part-a"), { recursive: true });
    writeFileSync(join(wt, "part-a", "out.txt"), "done\n");
    expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);

    const v = cli(wt, "verify", id);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("verdict=pass");

    const receipt = JSON.parse(readFileSync(join(wt, ".sddx/receipts", `${id}.json`), "utf8"));
    expect(receipt.verdict).toBe("pass");
    expect(receipt.env.runtime).toBe("bun");
    expect(verifyChain(wt)).toEqual([]);
  });

  test("the adapter-registered TDD gate blocks an implementation-first write", () => {
    const root = initialized("global");
    planOneNode(root);
    const { id } = createRunHere(root);
    const wt = join(root, ".sddx-worktrees", id);

    const gate = registeredCommands(root, "PreToolUse").find((c) => c.command.includes("tdd-gate"));
    expect(gate).toBeDefined();
    expect(gate!.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    // global scope: the registered command is the bare `sddx`
    expect(gate!.command).toBe("sddx hook tdd-gate");

    // A global `sddx` on PATH, as the registered command assumes.
    const shimDir = join(root, ".test-bin");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "sddx");
    writeFileSync(shim, `#!/bin/sh\nexec bun ${CLI} "$@"\n`);
    chmodSync(shim, 0o755);

    const denied = fireHook(
      wt,
      gate!.command,
      editEvent(wt, join(wt, "part-a", "impl.ts")),
      shimDir,
    );
    expect(denied.status).toBe(0);
    expect(denyReason(denied.out)).toContain(id);

    // ...and a test path stays writable, so the gate is discriminating rather
    // than simply refusing everything.
    const allowed = fireHook(
      wt,
      gate!.command,
      editEvent(wt, join(wt, "tests", "widget.test.ts")),
      shimDir,
    );
    expect(denyReason(allowed.out)).toBeUndefined();
  });
});

describe("autonomous flow, project-pinned runtime scope, no plugin", () => {
  test("runs unattended to a verified receipt", () => {
    const root = initialized("project");
    pinLocalBinary(root);

    // auto mode: no human approval round, the plan self-authorizes within bounds
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.interaction_mode = "auto";
    writeFileSync(join(root, ".sddx/config.json"), `${JSON.stringify(cfg, null, 2)}\n`);

    planOneNode(root);
    const r = cli(root, "graph", "create", "--graph", "graph.yaml", "--output", "json");
    expect(r.status).toBe(0);
    const id = (JSON.parse(r.stdout).data as { taskIds: string[] }).taskIds[0] as string;

    const wt = join(root, ".sddx-worktrees", id);
    expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, id);
    mkdirSync(join(wt, "part-a"), { recursive: true });
    writeFileSync(join(wt, "part-a", "out.txt"), "done\n");
    expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(cli(wt, "verify", id).status).toBe(0);

    expect(verifyChain(wt)).toEqual([]);
  });

  test("the registered command resolves the project-local binary and gates a write", () => {
    const root = initialized("project");
    pinLocalBinary(root);
    planOneNode(root);

    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.interaction_mode = "auto";
    writeFileSync(join(root, ".sddx/config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    const r = cli(root, "graph", "create", "--graph", "graph.yaml", "--output", "json");
    expect(r.status).toBe(0);
    const id = (JSON.parse(r.stdout).data as { taskIds: string[] }).taskIds[0] as string;
    const wt = join(root, ".sddx-worktrees", id);

    const gate = registeredCommands(root, "PreToolUse").find((c) =>
      c.command.includes("tdd-gate"),
    )!;
    // project scope: the verified no-install local execution form, not `sddx`
    expect(gate.command).toBe("npm exec --offline --no -- sddx hook tdd-gate");

    // The worktree needs the same node_modules the main checkout has, since
    // npm resolves the local binary relative to the working directory.
    pinLocalBinary(wt);

    const denied = fireHook(wt, gate.command, editEvent(wt, join(wt, "part-a", "impl.ts")));
    expect(denied.status).toBe(0);
    expect(denyReason(denied.out)).toContain(id);
  });
});

describe("no plugin anywhere", () => {
  test("an initialized repository contains no plugin or marketplace artifact", () => {
    const root = initialized("global");
    for (const p of [".claude-plugin", ".claude-plugin/marketplace.json", "hooks/hooks.json"]) {
      expect(existsSync(join(root, p))).toBe(false);
    }
    const settings = readFileSync(join(root, ".claude/settings.json"), "utf8");
    expect(settings).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(settings).not.toContain("dist/hooks.mjs");
  });
});
