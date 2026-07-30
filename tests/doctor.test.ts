// `sddx doctor`. Two invariants run through every test here: it never writes,
// and every non-passing check names the command that fixes it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface Check {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

function checks(cwd: string): { checks: Check[]; failed: boolean; status: number } {
  const r = cli(cwd, "doctor", "--output", "json");
  const envelope = JSON.parse(r.stdout) as { data: { checks: Check[]; failed: boolean } };
  return { ...envelope.data, status: r.status };
}

const byId = (list: Check[], id: string): Check | undefined => list.find((c) => c.id === id);

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) Object.assign(out, snapshot(abs, base));
    else out[relative(base, abs)] = readFileSync(abs, "utf8");
  }
  return out;
}

function initialized(...extra: string[]): string {
  const root = fixtureRepo();
  const r = cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude", ...extra);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}${r.stdout}`);
  return root;
}

describe("the full picture", () => {
  test("a healthy repository passes every check and exits 0", () => {
    const { checks: list, failed, status } = checks(initialized());
    expect(failed).toBe(false);
    expect(status).toBe(0);
    for (const id of [
      "bun",
      "git-repository",
      "sddx-version",
      "project-config",
      "runtime-scope",
      "runtime-resolution",
      "adapter:claude",
      "legacy-plugin",
    ]) {
      expect(byId(list, id)?.status).toBe("pass");
    }
  });

  test("every non-passing check carries an exact fix command", () => {
    // The property that makes doctor worth running, asserted across a repo
    // deliberately broken in several ways at once.
    const root = fixtureRepo();
    write(root, ".sddx/config.json", JSON.stringify({ schema_version: "0.1", nonsense_key: 1 }));
    const { checks: list } = checks(root);
    const notPassing = list.filter((c) => c.status !== "pass");
    expect(notPassing.length).toBeGreaterThan(0);
    for (const c of notPassing) {
      expect(c.fix, `check ${c.id} has no fix`).toBeTruthy();
    }
  });

  test("runs outside a git repository without crashing", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "sddx-nonrepo-"));
    const { checks: list, failed, status } = checks(notARepo);
    expect(failed).toBe(true);
    expect(status).toBe(1);
    const git = byId(list, "git-repository")!;
    expect(git.status).toBe("fail");
    expect(git.fix).toContain("git init");
  });

  test("an uninitialized repository names sddx init", () => {
    const { checks: list, status } = checks(fixtureRepo());
    expect(status).toBe(1);
    const cfg = byId(list, "project-config")!;
    expect(cfg.status).toBe("fail");
    expect(cfg.fix).toBe("sddx init");
  });
});

describe("read-only", () => {
  test("changes nothing, in a healthy repository or a broken one", () => {
    for (const root of [initialized(), fixtureRepo()]) {
      const before = snapshot(root);
      cli(root, "doctor");
      expect(snapshot(root)).toEqual(before);
    }
  });
});

describe("runtime resolution", () => {
  test("project scope without the dependency fails, naming the install command", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project";
    cfg.package_manager = "npm";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);

    const { checks: list, failed } = checks(root);
    expect(failed).toBe(true);
    const res = byId(list, "runtime-resolution")!;
    expect(res.status).toBe("fail");
    expect(res.fix).toBe("npm install --save-dev @glapsfun/sddx");
  });

  test("the bun package manager gets bun's install command", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project";
    cfg.package_manager = "bun";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);

    expect(byId(checks(root).checks, "runtime-resolution")!.fix).toBe(
      "bun add --dev @glapsfun/sddx",
    );
  });

  test("a declared but uninstalled dependency is distinguished from an undeclared one", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);
    write(
      root,
      "package.json",
      JSON.stringify({ name: "x", devDependencies: { "@glapsfun/sddx": "^4.0.0" } }, null, 2),
    );

    const res = byId(checks(root).checks, "runtime-resolution")!;
    expect(res.detail).toContain("not installed");
    expect(res.fix).toBe("npm install");
  });

  test("a version mismatch warns with both versions rather than failing", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);
    write(
      root,
      "package.json",
      JSON.stringify({ name: "x", devDependencies: { "@glapsfun/sddx": "^0.0.1" } }, null, 2),
    );
    write(
      root,
      "node_modules/@glapsfun/sddx/package.json",
      JSON.stringify({ name: "@glapsfun/sddx", version: "0.0.1" }),
    );

    const res = byId(checks(root).checks, "runtime-resolution")!;
    expect(res.status).toBe("warn");
    expect(res.detail).toContain("0.0.1");
  });

  test("a global binary against a pinned repository is reported, not silently accepted", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project";
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);

    const mismatch = byId(checks(root).checks, "runtime-mismatch");
    // Only meaningful when a global sddx actually exists on this machine.
    if (mismatch) {
      expect(mismatch.status).toBe("warn");
      expect(mismatch.fix).toContain("npm exec --offline --no -- sddx");
    }
  });
});

describe("adapter health", () => {
  test("a modified generated file fails, naming sync", () => {
    const root = initialized();
    write(root, ".claude/agents/sddx-verifier.md", "# hand-edited\n");

    const { checks: list, failed } = checks(root);
    expect(failed).toBe(true);
    const adapter = byId(list, "adapter:claude")!;
    expect(adapter.status).toBe("fail");
    expect(adapter.detail).toContain("sddx-verifier.md");
    expect(adapter.fix).toContain("sddx sync --adapter claude");
  });

  test("a stale generated file warns, naming sync --yes", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.runtime_scope = "project"; // policy moved; generated content has not
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);

    const adapter = byId(checks(root).checks, "adapter:claude")!;
    expect(adapter.status).toBe("warn");
    expect(adapter.fix).toContain("sddx sync --adapter claude --yes");
  });

  test("an adapter this sddx does not implement is reported", () => {
    const root = initialized();
    const cfg = JSON.parse(readFileSync(join(root, ".sddx/config.json"), "utf8"));
    cfg.adapters = ["emacs"];
    write(root, ".sddx/config.json", `${JSON.stringify(cfg, null, 2)}\n`);

    const adapter = byId(checks(root).checks, "adapter:emacs")!;
    expect(adapter.status).toBe("fail");
    expect(adapter.detail).toContain("does not implement");
  });

  test("no adapters enabled is a pass, not a warning", () => {
    const root = fixtureRepo();
    cli(root, "init", "--yes", "--runtime", "global");
    expect(byId(checks(root).checks, "adapters")!.status).toBe("pass");
  });
});

describe("legacy plugin detection", () => {
  test("a marketplace manifest is reported with the ordered migration steps", () => {
    const root = initialized();
    write(root, ".claude-plugin/marketplace.json", "{}\n");

    const legacy = byId(checks(root).checks, "legacy-plugin")!;
    expect(legacy.status).toBe("warn");
    expect(legacy.detail).toContain("marketplace.json");
    expect(legacy.fix).toContain("sddx init --adapter claude");
    expect(legacy.fix).toContain("sddx doctor");
  });

  test("plugin-root hook registrations are reported as duplicates", () => {
    const root = initialized();
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    settings.hooks.SessionStart!.push({
      hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" x' }],
    });
    write(root, ".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);

    const legacy = byId(checks(root).checks, "legacy-plugin")!;
    expect(legacy.status).toBe("warn");
    expect(legacy.detail).toContain("plugin-root hooks");
  });

  test("detection never removes anything", () => {
    const root = initialized();
    write(root, ".claude-plugin/marketplace.json", "{}\n");
    cli(root, "doctor");
    expect(existsSync(join(root, ".claude-plugin/marketplace.json"))).toBe(true);
  });
});

describe("output", () => {
  test("JSON carries every check under the envelope's data key", () => {
    const r = cli(initialized(), "doctor", "--output", "json");
    const envelope = JSON.parse(r.stdout) as {
      data: { checks: Check[]; failed: boolean };
      metadata: { plugin_version: string };
    };
    expect(Array.isArray(envelope.data.checks)).toBe(true);
    for (const c of envelope.data.checks) {
      expect(typeof c.id).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
    expect(envelope.metadata.plugin_version).not.toBe("unknown");
  });

  test("terminal output prints the fix under each failing check", () => {
    const r = cli(fixtureRepo(), "doctor");
    expect(r.status).toBe(1);
    const combined = `${r.stdout}${r.stderr}`;
    expect(combined).toContain("project-config");
    expect(combined).toContain("fix: sddx init");
  });
});

describe("generated files must reach teammates", () => {
  test("gitignored adapter output warns — a gate only one person has is not a gate", () => {
    const root = initialized();
    write(root, ".gitignore", ".claude\n");

    const tracked = byId(checks(root).checks, "adapter:claude:tracked")!;
    expect(tracked.status).toBe("warn");
    expect(tracked.detail).toContain("teammates");
    expect(tracked.fix).toContain("git check-ignore");
  });

  test("normally tracked adapter output produces no such warning", () => {
    expect(byId(checks(initialized()).checks, "adapter:claude:tracked")).toBeUndefined();
  });
});

/**
 * Regressions from the high-effort review. doctor is documented as read-only
 * and degrading to a reportable state; these are the inputs that used to make
 * it throw a bare parse error and print no checks at all — the one command a
 * user reaches for when their setup is already broken.
 */
describe("doctor survives damaged inputs", () => {
  test("a malformed .claude/settings.json is reported, not thrown", () => {
    const root = initialized();
    write(root, ".claude/settings.json", "oops not json\n");

    const { checks: list } = checks(root);
    expect(list.length).toBeGreaterThan(0);
    const adapter = byId(list, "adapter:claude")!;
    expect(adapter.status).toBe("fail");
    expect(adapter.detail).toContain("settings.json");
    expect(adapter.fix).toBeTruthy();
  });

  test("a settings file holding a JSON array is reported, not thrown", () => {
    const root = initialized();
    write(root, ".claude/settings.json", "[1, 2, 3]\n");
    expect(byId(checks(root).checks, "adapter:claude")!.status).toBe("fail");
  });

  test("an ownership manifest missing its files key does not crash any command", () => {
    const root = initialized();
    write(root, ".sddx/local/adapters/claude-install.json", '{"schema_version":"1.0"}\n');
    write(root, ".claude/agents/sddx-planner.md", "# drifted\n");

    const { checks: list } = checks(root);
    expect(list.length).toBeGreaterThan(0);
    expect(cli(root, "sync", "--adapter", "claude").status).not.toBe(-1);
    expect(cli(root, "uninstall", "--adapter", "claude").status).toBe(0);
  });

  test("a truncated manifest does not crash uninstall", () => {
    const root = initialized();
    write(root, ".sddx/local/adapters/claude-install.json", "{ truncated");
    const r = cli(root, "uninstall", "--adapter", "claude");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("is not an object");
  });
});
