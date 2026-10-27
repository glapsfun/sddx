import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NOT_OPTED_IN_LINE } from "../src/lib/hookdispatch";
import { V5_OWNED } from "../src/lib/legacy/v5-claude";
import { optedInRoot } from "../src/lib/optin";
import { fixtureRepo } from "./fixtures";
import { completeTask, createRun, repoRoot, startTask } from "./helpers";
import { contextOf, runLauncher } from "./hook-launcher";
import { scenario } from "./scenario";

/** A directory layout, relative to a fresh base: git repositories to init,
 * directories and empty files to create, and the session's working directory. */
interface OptInCase {
  name: string;
  git?: string[];
  dirs?: string[];
  files?: string[];
  cwd: string;
  optedIn: boolean;
}

const OPT_IN_CASES: OptInCase[] = [
  { name: "repository root with .sddx/", git: ["."], dirs: [".sddx"], cwd: ".", optedIn: true },
  {
    name: "subdirectory of an opted-in repository",
    git: ["."],
    dirs: [".sddx", "src"],
    cwd: "src",
    optedIn: true,
  },
  { name: "repository without .sddx/", git: ["."], cwd: ".", optedIn: false },
  {
    name: "nested repository inside a directory with .sddx/",
    git: ["inner"],
    dirs: [".sddx", "inner"],
    cwd: "inner",
    optedIn: false,
  },
  { name: "directory outside git with .sddx/", dirs: [".sddx"], cwd: ".", optedIn: true },
  {
    name: "subdirectory outside git whose parent has .sddx/",
    dirs: [".sddx", "sub"],
    cwd: "sub",
    optedIn: false,
  },
  { name: ".sddx that is a file", git: ["."], files: [".sddx"], cwd: ".", optedIn: false },
  {
    name: "worktree whose .git is a file",
    dirs: [".sddx"],
    files: [".git"],
    cwd: ".",
    optedIn: true,
  },
];

function caseDir(c: OptInCase): string {
  const base = mkdtempSync(join(tmpdir(), "optin-"));
  for (const d of c.dirs ?? []) mkdirSync(join(base, d), { recursive: true });
  for (const f of c.files ?? []) writeFileSync(join(base, f), "");
  for (const g of c.git ?? [])
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: join(base, g) });
  return join(base, c.cwd);
}

/** The launcher's verdict, observed through whether a stop-gate call starts Bun:
 * the stop gate is the hook that still follows the opt-in rule. */
const launcherOptedIn = (cwd: string): boolean =>
  runLauncher("stop-gate", { hook_event_name: "Stop", cwd }, { cwd, bun: { stdout: "{}" } })
    .bunCalls.length > 0;

describe("opt-in: the TypeScript rule and the launcher's agree", () => {
  for (const c of OPT_IN_CASES) {
    test(c.name, () => {
      const cwd = caseDir(c);
      expect(optedInRoot(cwd) !== null).toBe(c.optedIn);
      expect(launcherOptedIn(cwd)).toBe(c.optedIn);
    });
  }

  scenario("session-router", "Session started in a subdirectory", () => {
    const c = OPT_IN_CASES.find(
      (x) => x.name === "subdirectory of an opted-in repository",
    ) as OptInCase;
    const cwd = caseDir(c);
    expect(optedInRoot(cwd)).toBe(dirname(cwd));
    expect(launcherOptedIn(cwd)).toBe(true);
  });

  scenario("session-router", "Nested repository without .sddx/", () => {
    const c = OPT_IN_CASES.find(
      (x) => x.name === "nested repository inside a directory with .sddx/",
    ) as OptInCase;
    const cwd = caseDir(c);
    expect(optedInRoot(cwd)).toBeNull();
    expect(launcherOptedIn(cwd)).toBe(false);
  });
});

const ROUTER_BODY = "ROUTER-BODY-MARKER: route behavior changes through sddx.";
const MAPPING_BODY = "MAPPING-MARKER: dispatch a subagent with the Agent tool.";
const CODEX_MAPPING_BODY = "CODEX-MAPPING-MARKER: dispatch a subagent with spawn_agent.";

/** A plugin root holding only the two router files session start injects. */
function fixturePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-"));
  const dir = join(root, "skills", "using-sddx");
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: using-sddx\ndescription: frontmatter stays out\n---\n\n${ROUTER_BODY}\n`,
  );
  writeFileSync(join(dir, "references", "claude-code.md"), `${MAPPING_BODY}\n`);
  writeFileSync(join(dir, "references", "codex.md"), `${CODEX_MAPPING_BODY}\n`);
  return root;
}

const BUN_DIR = dirname(Bun.which("bun") as string);

/** Runs session start from source the way the launcher would, on a PATH with no sddx. */
function sessionStart(
  cwd: string,
  opts: { plugin?: string; pathPrefix?: string; harness?: "codex" } = {},
) {
  const plugin = opts.plugin ?? fixturePlugin();
  const args = [join(repoRoot, "src", "hooks.ts"), "session-start"];
  const r = spawnSync("bun", opts.harness ? [...args, opts.harness] : args, {
    cwd,
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd }),
    encoding: "utf8",
    env: {
      PATH: [opts.pathPrefix, BUN_DIR, "/usr/bin", "/bin"].filter(Boolean).join(":"),
      HOME: process.env.HOME ?? "",
      CLAUDE_PLUGIN_ROOT: plugin,
      ...(opts.harness === "codex" ? { PLUGIN_ROOT: plugin } : {}),
      NO_COLOR: "1",
    },
  });
  const out = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
  return { status: r.status, context: contextOf(out), out };
}

function optedInRepo(): string {
  const cwd = fixtureRepo();
  mkdirSync(join(cwd, ".sddx"));
  return cwd;
}

describe("session start by repository state", () => {
  scenario("session-router", "Router injected", () => {
    const { status, context } = sessionStart(optedInRepo());
    expect(status).toBe(0);
    expect(context).toContain(ROUTER_BODY);
    expect(context).toContain(MAPPING_BODY);
    expect(context).toContain("Run sddx as: sddx");
    expect(context).not.toContain("frontmatter stays out");
  });

  scenario("session-router", "Unfinished tasks listed", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    startTask(cwd, "T1");
    completeTask(cwd, "T2");
    const { context } = sessionStart(cwd);
    expect(context).toContain("sddx task T1: IN_PROGRESS, Task T1");
    expect(context).not.toContain("T2");
  });

  scenario("session-router", "Repository without .sddx/", () => {
    const cwd = fixtureRepo();
    const before = spawnSync("git", ["status", "--porcelain", "--ignored"], {
      cwd,
      encoding: "utf8",
    });
    const { status, context } = sessionStart(cwd);
    expect(status).toBe(0);
    expect(context).toBe(NOT_OPTED_IN_LINE);
    expect(context.split("\n")).toHaveLength(1);
    expect(context).toContain("/sddx:brainstorm");
    const after = spawnSync("git", ["status", "--porcelain", "--ignored"], {
      cwd,
      encoding: "utf8",
    });
    expect(after.stdout).toBe(before.stdout);
  });

  scenario("session-router", "v5 configuration", () => {
    const cwd = optedInRepo();
    writeFileSync(join(cwd, ".sddx", "config.json"), '{ "schema_version": "1.0" }\n');
    const { context } = sessionStart(cwd);
    expect(context).toContain("sddx migrate");
    expect(context).not.toContain(ROUTER_BODY);
  });

  scenario("session-router", "Edited v5 file kept after migration", () => {
    const cwd = optedInRepo();
    const kept = Object.keys(V5_OWNED)[0] as string;
    mkdirSync(dirname(join(cwd, kept)), { recursive: true });
    writeFileSync(join(cwd, kept), "edited by hand, so sddx migrate keeps it\n");
    const { status, context } = sessionStart(cwd);
    expect(status).toBe(0);
    expect(context).toContain(ROUTER_BODY);
    expect(context).toContain(kept);
    expect(context).not.toContain("sddx 6 does not run");
  });

  scenario("session-router", "v5 hooks still registered", () => {
    const cwd = optedInRepo();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "sddx hook bash-gate" }] },
          ],
        },
      }),
    );
    const { context } = sessionStart(cwd);
    expect(context).toContain("sddx migrate");
    expect(context).toContain("both sets of hooks would fire");
    expect(context).not.toContain(ROUTER_BODY);
  });
});

/** A directory holding an executable named sddx. */
function sddxOnPath(dir = mkdtempSync(join(tmpdir(), "path-"))): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sddx"), "#!/bin/sh\necho 5.0.0\n");
  chmodSync(join(dir, "sddx"), 0o755);
  return dir;
}

describe("the command session start gives always reaches the plugin's CLI", () => {
  scenario("session-router", "Older sddx on PATH", () => {
    const plugin = fixturePlugin();
    const older = sddxOnPath();
    const { context } = sessionStart(optedInRepo(), { plugin, pathPrefix: older });
    expect(context).toContain(`Run sddx as: ${join(plugin, "bin", "sddx")}`);
    expect(context).toContain(join(older, "sddx"));
  });

  scenario("session-router", "No other sddx", () => {
    const { context } = sessionStart(optedInRepo());
    expect(context).toContain("Run sddx as: sddx\n");
    expect(context).not.toContain("Warning: another sddx");
  });

  scenario("session-router", "Link to the plugin's own launcher", () => {
    const plugin = fixturePlugin();
    const own = sddxOnPath(join(plugin, "bin"));
    const links = mkdtempSync(join(tmpdir(), "links-"));
    symlinkSync(join(own, "sddx"), join(links, "sddx"));
    const { context } = sessionStart(optedInRepo(), { plugin, pathPrefix: links });
    expect(context).toContain("Run sddx as: sddx\n");
    expect(context).not.toContain("Warning: another sddx");
  });

  test("a router saved with CRLF line endings loses its frontmatter too", () => {
    const plugin = fixturePlugin();
    const skill = join(plugin, "skills", "using-sddx", "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replaceAll("\n", "\r\n"));
    const { context } = sessionStart(optedInRepo(), { plugin });
    expect(context).toContain(ROUTER_BODY);
    expect(context).not.toContain("frontmatter stays out");
  });

  test("the plugin's own bin/ on PATH is not a shadow", () => {
    const plugin = fixturePlugin();
    const own = sddxOnPath(join(plugin, "bin"));
    const { context } = sessionStart(optedInRepo(), { plugin, pathPrefix: own });
    expect(context).toContain("Run sddx as: sddx\n");
  });

  test("a non-executable file named sddx is not a shadow", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-"));
    writeFileSync(join(dir, "sddx"), "not a program\n");
    const { context } = sessionStart(optedInRepo(), { pathPrefix: dir });
    expect(context).toContain("Run sddx as: sddx\n");
  });
});

describe("session start never breaks a session", () => {
  scenario("session-router", "No Bun", () => {
    for (const cwd of [optedInRepo(), fixtureRepo()]) {
      const r = runLauncher(
        "session-start",
        { hook_event_name: "SessionStart", cwd },
        {
          cwd,
          bun: "none",
        },
      );
      expect(r.status).toBe(0);
      expect(contextOf(r.out)).toContain("curl -fsSL https://bun.sh/install | bash");
    }
  });

  scenario("session-router", "Unreadable task file", () => {
    const cwd = optedInRepo();
    mkdirSync(join(cwd, ".sddx", "tasks"));
    writeFileSync(join(cwd, ".sddx", "tasks", "T9.json"), "{ not json");
    const { status, context } = sessionStart(cwd);
    expect(status).toBe(0);
    expect(context).toContain(join(cwd, ".sddx", "tasks", "T9.json"));
    expect(context).toContain("unreadable");
  });
});

describe("one failing part of session start does not withhold the rest", () => {
  scenario("session-router", "Malformed Claude settings", () => {
    const cwd = optedInRepo();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: { matcher: "Bash" } } }),
    );
    const { status, context } = sessionStart(cwd);
    expect(status).toBe(0);
    expect(context).toContain(ROUTER_BODY);
    expect(context).toContain("sddx 5");
  });
});

describe("session start in Codex", () => {
  const codex = { harness: "codex" as const };

  scenario("session-router", "Router injected in Codex", () => {
    const { status, context } = sessionStart(optedInRepo(), codex);
    expect(status).toBe(0);
    expect(context).toContain(ROUTER_BODY);
    expect(context).toContain(CODEX_MAPPING_BODY);
    expect(context).not.toContain(MAPPING_BODY);
  });

  scenario("session-router", "Repository without .sddx/ in Codex", () => {
    const cwd = fixtureRepo();
    const status = () =>
      spawnSync("git", ["status", "--porcelain", "--ignored"], { cwd, encoding: "utf8" }).stdout;
    const before = status();
    const { context } = sessionStart(cwd, codex);
    expect(context.split("\n")).toHaveLength(1);
    expect(context).toContain("$sddx:brainstorm");
    expect(context).not.toContain("/sddx:brainstorm");
    expect(status()).toBe(before);
  });

  scenario("session-router", "Codex session", () => {
    const plugin = fixturePlugin();
    const { context } = sessionStart(optedInRepo(), { ...codex, plugin });
    expect(context).toContain(`Run sddx as: ${join(plugin, "bin", "sddx")}\n`);
    expect(context).not.toContain("Run sddx as: sddx\n");
  });

  test("in Codex another sddx on PATH changes nothing: the command is already absolute", () => {
    const plugin = fixturePlugin();
    const { context } = sessionStart(optedInRepo(), {
      ...codex,
      plugin,
      pathPrefix: sddxOnPath(),
    });
    expect(context).toContain(`Run sddx as: ${join(plugin, "bin", "sddx")}\n`);
    expect(context).not.toContain("Warning: another sddx");
  });

  scenario("session-router", "Strict repository in Codex", () => {
    const cwd = optedInRepo();
    writeFileSync(join(cwd, ".sddx", "config.json"), '{ "profile": "strict" }\n');
    const { context } = sessionStart(cwd, codex);
    expect(context).toContain("per-edit gates do not run in Codex");
    expect(context).toContain("sddx task phase");
  });

  scenario("session-router", "Strict repository in Claude Code", () => {
    const cwd = optedInRepo();
    writeFileSync(join(cwd, ".sddx", "config.json"), '{ "profile": "strict" }\n');
    const { context } = sessionStart(cwd);
    expect(context).not.toContain("per-edit gates do not run");
  });

  test("a default-profile repository in Codex gets no strict note", () => {
    expect(sessionStart(optedInRepo(), codex).context).not.toContain("per-edit gates");
  });

  scenario("codex-hooks", "Session start shape in Codex", () => {
    for (const cwd of [optedInRepo(), fixtureRepo()]) {
      const { out } = sessionStart(cwd, codex);
      expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
      const inner = out.hookSpecificOutput as Record<string, unknown>;
      expect(Object.keys(inner).sort()).toEqual(["additionalContext", "hookEventName"]);
      expect(inner.hookEventName).toBe("SessionStart");
    }
  });
});
