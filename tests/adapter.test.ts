// The adapter contract and its Claude implementation. The theme throughout:
// sddx writes only what it can prove it owns, and proves it by content hash.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AdapterConflictError,
  type AdapterContext,
  applyAdapter,
  declarationPath,
  manifestPath,
  planAdapter,
  planHasConflicts,
  readManifest,
  uninstallAdapter,
} from "../src/lib/adapter";
import { claudeAdapter, INVOCATION_PLACEHOLDER } from "../src/lib/adapters/claude";
import { sddxCommand } from "../src/lib/runtime";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  runtimeScope: "global",
  packageManager: "npm",
  invocation: sddxCommand("global", "npm"),
  sddxVersion: "9.9.9",
  ...over,
});

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** A repo with the Claude adapter freshly installed. */
function installed(over: Partial<AdapterContext> = {}): { root: string; ctx: AdapterContext } {
  const root = fixtureRepo();
  const c = ctx(over);
  applyAdapter(root, claudeAdapter, c);
  return { root, ctx: c };
}

describe("generation is pure", () => {
  test("the same context produces byte-identical files", () => {
    const a = claudeAdapter.generate(ctx());
    const b = claudeAdapter.generate(ctx());
    expect(a).toEqual(b);
  });

  test("ambient machine state does not change the output", () => {
    const before = claudeAdapter.generate(ctx());
    const savedPath = process.env.PATH;
    const savedCwd = process.cwd();
    try {
      process.env.PATH = "/nonexistent";
      process.chdir(fixtureRepo());
      expect(claudeAdapter.generate(ctx())).toEqual(before);
    } finally {
      process.env.PATH = savedPath;
      process.chdir(savedCwd);
    }
  });

  test("the invocation is the only thing that varies with policy", () => {
    const globalFiles = claudeAdapter.generate(ctx());
    const pinned = claudeAdapter.generate(
      ctx({ runtimeScope: "project", invocation: sddxCommand("project", "npm") }),
    );
    expect(pinned.map((f) => f.path)).toEqual(globalFiles.map((f) => f.path));

    const runSkill = pinned.find((f) => f.path.endsWith("sddx-run/SKILL.md"))!;
    expect(runSkill.contents).toContain("npm exec --offline --no -- sddx");
  });

  test("no generated file references a plugin root, bundle, or launcher", () => {
    for (const scope of ["global", "project"] as const) {
      const files = claudeAdapter.generate(
        ctx({ runtimeScope: scope, invocation: sddxCommand(scope, "npm") }),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(f.contents).not.toContain("CLAUDE_PLUGIN_ROOT");
        expect(f.contents).not.toContain("dist/cli.mjs");
        expect(f.contents).not.toContain("dist/hooks.mjs");
        expect(f.contents).not.toContain("sddx-run");
        expect(f.contents).not.toContain(INVOCATION_PLACEHOLDER);
      }
    }
  });

  test("assets are sddx-prefixed and confined to .claude/", () => {
    for (const f of claudeAdapter.generate(ctx())) {
      expect(f.path.startsWith(".claude/")).toBe(true);
      expect(f.path).toMatch(/\/sddx-/);
    }
  });
});

describe("install", () => {
  test("writes the full asset set and an ownership manifest", () => {
    const { root, ctx: c } = installed();
    for (const role of ["intake", "orchestrator", "planner", "tdd-executor", "verifier"]) {
      expect(existsSync(join(root, `.claude/agents/sddx-${role}.md`))).toBe(true);
    }
    for (const skill of ["run", "plan", "verify", "board", "audit", "pr"]) {
      expect(existsSync(join(root, `.claude/skills/sddx-${skill}/SKILL.md`))).toBe(true);
    }
    const manifest = readManifest(root, "claude")!;
    expect(manifest.adapter).toBe("claude");
    expect(manifest.sddx_version).toBe("9.9.9");
    expect(manifest.invocation).toBe(c.invocation);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
  });

  test("registers every hook event in the team-shared settings file", () => {
    const { root } = installed();
    const settings = JSON.parse(read(root, ".claude/settings.json")) as {
      hooks: Record<string, unknown[]>;
    };
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
      expect(settings.hooks[event]?.length).toBeGreaterThan(0);
    }
    // team-shared, not the personal gitignored file
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
  });

  test("writes nothing outside the repository", () => {
    // Every generated and merged path is repo-relative and stays inside it.
    const paths = [
      ...claudeAdapter.generate(ctx()).map((f) => f.path),
      ...claudeAdapter.mergeTargets(ctx()).map((t) => t.path),
    ];
    for (const p of paths) {
      expect(p.startsWith("/")).toBe(false);
      expect(p.split("/")).not.toContain("..");
    }
  });

  test("a re-install is a byte-identical no-op", () => {
    const { root, ctx: c } = installed();
    const before = read(root, ".claude/settings.json");
    const plan = planAdapter(root, claudeAdapter, c);
    expect(plan.dispositions.every((d) => d.kind === "unchanged")).toBe(true);
    applyAdapter(root, claudeAdapter, c);
    expect(read(root, ".claude/settings.json")).toBe(before);
  });
});

describe("collision refusal", () => {
  test("a user-authored file at a generated path refuses, writing nothing", () => {
    const root = fixtureRepo();
    write(root, ".claude/agents/sddx-planner.md", "# my own planner\n");
    const mine = read(root, ".claude/agents/sddx-planner.md");

    const plan = planAdapter(root, claudeAdapter, ctx());
    expect(planHasConflicts(plan)).toBe(true);
    expect(plan.conflicts[0]!.path).toBe(".claude/agents/sddx-planner.md");

    expect(() => applyAdapter(root, claudeAdapter, ctx())).toThrow(AdapterConflictError);
    expect(read(root, ".claude/agents/sddx-planner.md")).toBe(mine);
    // and the apply was all-or-nothing: no other asset landed either
    expect(existsSync(join(root, ".claude/skills/sddx-run/SKILL.md"))).toBe(false);
  });

  test("an sddx file modified by hand refuses on the next apply", () => {
    const { root, ctx: c } = installed();
    write(root, ".claude/agents/sddx-verifier.md", "# edited by a human\n");

    const plan = planAdapter(root, claudeAdapter, c);
    expect(plan.conflicts.map((x) => x.path)).toContain(".claude/agents/sddx-verifier.md");
    expect(plan.conflicts[0]!.reason).toContain("modified");
  });

  test("--force backs the conflicting file up before overwriting", () => {
    const { root, ctx: c } = installed();
    write(root, ".claude/agents/sddx-verifier.md", "# edited by a human\n");

    const result = applyAdapter(root, claudeAdapter, c, { force: true });
    expect(result.backedUp).toContain(".claude/agents/sddx-verifier.md.bak");
    expect(read(root, ".claude/agents/sddx-verifier.md.bak")).toBe("# edited by a human\n");
    expect(read(root, ".claude/agents/sddx-verifier.md")).not.toContain("edited by a human");
  });

  test("a stale generation is updated, not treated as a conflict", () => {
    // Install, then re-generate with a different invocation: sddx owns the file
    // (its hash matches the manifest), so this is exactly what sync is for.
    const { root } = installed();
    const pinned = ctx({ runtimeScope: "project", invocation: sddxCommand("project", "npm") });
    const plan = planAdapter(root, claudeAdapter, pinned);
    expect(planHasConflicts(plan)).toBe(false);
    expect(plan.dispositions.some((d) => d.kind === "update")).toBe(true);
  });

  test("a missing manifest is recoverable, not a conflict", () => {
    const { root, ctx: c } = installed();
    rmSync(join(root, manifestPath("claude")), { force: true });
    // Content still matches what generation produces, so ownership is provable
    // without the manifest — a teammate who cloned but never installed.
    const plan = planAdapter(root, claudeAdapter, c);
    expect(planHasConflicts(plan)).toBe(false);
    expect(plan.dispositions.every((d) => d.kind === "unchanged")).toBe(true);
  });
});

describe("settings merge", () => {
  test("unrelated keys and foreign hook entries survive verbatim", () => {
    const root = fixtureRepo();
    write(
      root,
      ".claude/settings.json",
      `${JSON.stringify(
        {
          model: "opus",
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] },
            ],
            Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );

    applyAdapter(root, claudeAdapter, ctx());
    const after = JSON.parse(read(root, ".claude/settings.json")) as Record<string, unknown>;

    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    const hooks = after.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Notification![0]!.hooks[0]!.command).toBe("notify-send hi");
    // the user's own PreToolUse entry is kept alongside sddx's
    const commands = hooks.PreToolUse!.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain("my-own-linter");
    expect(commands.some((c) => c.includes("sddx hook tdd-gate"))).toBe(true);
  });

  test("re-merging is byte-identical", () => {
    const { root, ctx: c } = installed();
    const once = read(root, ".claude/settings.json");
    applyAdapter(root, claudeAdapter, c);
    expect(read(root, ".claude/settings.json")).toBe(once);
  });

  test("editing an unrelated key does not make sync refuse", () => {
    // Fingerprinting the whole file would trip here; fingerprinting only the
    // sddx-owned region is what keeps this a legitimate no-op.
    const { root, ctx: c } = installed();
    const doc = JSON.parse(read(root, ".claude/settings.json")) as Record<string, unknown>;
    doc.model = "sonnet";
    write(root, ".claude/settings.json", `${JSON.stringify(doc, null, 2)}\n`);

    const plan = planAdapter(root, claudeAdapter, c);
    expect(planHasConflicts(plan)).toBe(false);
  });

  test("editing an sddx hook entry does make it refuse", () => {
    const { root, ctx: c } = installed();
    const doc = JSON.parse(read(root, ".claude/settings.json")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    doc.hooks.PreToolUse![0]!.hooks[0]!.command = "sddx hook tdd-gate --disabled";
    write(root, ".claude/settings.json", `${JSON.stringify(doc, null, 2)}\n`);

    const plan = planAdapter(root, claudeAdapter, c);
    expect(planHasConflicts(plan)).toBe(true);
    expect(plan.conflicts[0]!.path).toBe(".claude/settings.json");
  });

  test("a settings file that is not a JSON object is refused, not overwritten", () => {
    const root = fixtureRepo();
    write(root, ".claude/settings.json", "[1, 2, 3]\n");
    expect(() => applyAdapter(root, claudeAdapter, ctx())).toThrow(/not a JSON object/);
    expect(read(root, ".claude/settings.json")).toBe("[1, 2, 3]\n");
  });
});

describe("uninstall", () => {
  test("removes owned paths and leaves everything else", () => {
    const { root, ctx: c } = installed();
    write(root, ".claude/skills/my-own/SKILL.md", "# mine\n");
    write(root, "src/app.ts", "export const x = 1;\n");
    mkdirSync(join(root, ".sddx/receipts"), { recursive: true });
    write(root, ".sddx/receipts/keep.json", "{}\n");

    const result = uninstallAdapter(root, claudeAdapter, c);

    expect(existsSync(join(root, ".claude/agents/sddx-planner.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/sddx-run/SKILL.md"))).toBe(false);
    expect(result.removed.length).toBeGreaterThan(0);

    // untouched
    expect(read(root, ".claude/skills/my-own/SKILL.md")).toBe("# mine\n");
    expect(read(root, "src/app.ts")).toBe("export const x = 1;\n");
    expect(read(root, ".sddx/receipts/keep.json")).toBe("{}\n");
  });

  test("unmerges settings, keeping the user's own entries", () => {
    const root = fixtureRepo();
    write(
      root,
      ".claude/settings.json",
      `${JSON.stringify(
        {
          model: "opus",
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "my-own-linter" }] }] },
        },
        null,
        2,
      )}\n`,
    );
    applyAdapter(root, claudeAdapter, ctx());
    uninstallAdapter(root, claudeAdapter, ctx());

    const after = JSON.parse(read(root, ".claude/settings.json")) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(after.model).toBe("opus");
    const commands = Object.values(after.hooks)
      .flat()
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toEqual(["my-own-linter"]);
    expect(commands.some((c) => c.includes("sddx hook"))).toBe(false);
  });

  test("a locally modified owned file is kept, named, and not deleted", () => {
    const { root, ctx: c } = installed();
    write(root, ".claude/agents/sddx-planner.md", "# I changed this\n");

    const result = uninstallAdapter(root, claudeAdapter, c);
    expect(result.keptModified).toContain(".claude/agents/sddx-planner.md");
    expect(read(root, ".claude/agents/sddx-planner.md")).toBe("# I changed this\n");
  });

  test("removes the manifest and the declaration", () => {
    const root = fixtureRepo();
    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);
    expect(existsSync(join(root, declarationPath("claude")))).toBe(true);

    expect(cli(root, "uninstall", "--adapter", "claude").status).toBe(0);
    expect(existsSync(join(root, manifestPath("claude")))).toBe(false);
    expect(existsSync(join(root, declarationPath("claude")))).toBe(false);
    // project lifecycle state is untouched
    expect(existsSync(join(root, ".sddx/config.json"))).toBe(true);
  });
});

describe("sync", () => {
  test("reports up to date when nothing changed", () => {
    const root = fixtureRepo();
    cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude");
    const r = cli(root, "sync", "--adapter", "claude");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already up to date");
  });

  test("previews without writing until --yes", () => {
    const root = fixtureRepo();
    cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude");
    // flip policy so generated content goes stale
    const cfg = JSON.parse(read(root, ".sddx/config.json")) as Record<string, unknown>;
    cfg.runtime_scope = "project";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);
    const before = read(root, ".claude/skills/sddx-run/SKILL.md");

    const preview = cli(root, "sync", "--adapter", "claude");
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("--yes");
    expect(read(root, ".claude/skills/sddx-run/SKILL.md")).toBe(before);

    expect(cli(root, "sync", "--adapter", "claude", "--yes").status).toBe(0);
    expect(read(root, ".claude/skills/sddx-run/SKILL.md")).toContain(
      "npm exec --offline --no -- sddx",
    );
  });

  test("refuses with exit 3 when a generated file was modified", () => {
    const root = fixtureRepo();
    cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude");
    write(root, ".claude/agents/sddx-verifier.md", "# hand-edited\n");

    const r = cli(root, "sync", "--adapter", "claude", "--yes");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("sddx-verifier.md");
    expect(read(root, ".claude/agents/sddx-verifier.md")).toBe("# hand-edited\n");
  });

  test("leaves project lifecycle state and source untouched", () => {
    const root = fixtureRepo();
    cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude");
    mkdirSync(join(root, ".sddx/specs"), { recursive: true });
    write(root, ".sddx/specs/x.yaml", "task: keep me\n");
    write(root, "src/app.ts", "export const x = 1;\n");

    cli(root, "sync", "--adapter", "claude", "--yes");
    expect(read(root, ".sddx/specs/x.yaml")).toBe("task: keep me\n");
    expect(read(root, "src/app.ts")).toBe("export const x = 1;\n");
  });

  test("an unknown adapter is a usage error", () => {
    const root = fixtureRepo();
    const r = cli(root, "sync", "--adapter", "emacs");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("emacs");
  });
});

describe("determinism across machines", () => {
  test("two installs from the same policy produce identical bytes", () => {
    const a = fixtureRepo();
    const b = fixtureRepo();
    const savedPath = process.env.PATH;
    applyAdapter(a, claudeAdapter, ctx());
    try {
      // second install sees a completely different PATH
      process.env.PATH = "/nonexistent";
      applyAdapter(b, claudeAdapter, ctx());
    } finally {
      process.env.PATH = savedPath;
    }
    for (const f of claudeAdapter.generate(ctx())) {
      expect(read(b, f.path)).toBe(read(a, f.path));
    }
    expect(read(b, ".claude/settings.json")).toBe(read(a, ".claude/settings.json"));
  });

  test("no sddx runtime is vendored into .sddx/ under either scope", () => {
    for (const scope of ["global", "project"] as const) {
      const root = fixtureRepo();
      cli(root, "init", "--yes", "--runtime", scope, "--adapter", "claude");
      const listing = spawnSync("find", [join(root, ".sddx"), "-type", "f"], {
        encoding: "utf8",
      }).stdout;
      expect(listing).not.toContain(".mjs");
      expect(listing).not.toContain("sddx-run");
    }
  });
});
