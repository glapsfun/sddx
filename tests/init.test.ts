// `sddx init` — the bootstrap boundary. These run against throwaway
// repositories, never the developer's checkout, because every assertion here is
// about what a mutating command does to a repository someone cares about.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyInit,
  EPHEMERAL_PATHS,
  InitApplyError,
  type InitOptions,
  NotAGitRepositoryError,
  planInit,
  planIsNoop,
  repositoryRoot,
  withGitignoreBlock,
} from "../src/lib/init";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const OPTS: InitOptions = {
  runtimeScope: "global",
  packageManager: "npm",
  adapters: ["claude"],
  interactionMode: "human",
};

/** Every file in the tree, path → contents, so a whole repo can be compared. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue; // git's own bookkeeping churns on its own
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) Object.assign(out, snapshot(abs, base));
    else out[relative(base, abs)] = readFileSync(abs, "utf8");
  }
  return out;
}

describe("repository root resolution", () => {
  test("resolves from a subdirectory to the repository root", () => {
    const root = fixtureRepo();
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    // realpath, because macOS hands out /var → /private/var symlinked tmpdirs
    expect(repositoryRoot(nested)).toBe(repositoryRoot(root));
  });

  test("refuses outside a git repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "sddx-nonrepo-"));
    expect(() => repositoryRoot(notARepo)).toThrow(NotAGitRepositoryError);
  });

  test("init exits 1 outside a repository and creates nothing", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "sddx-nonrepo-"));
    const before = snapshot(notARepo);
    const r = cli(notARepo, "init", "--yes", "--runtime", "global");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a git repository");
    expect(snapshot(notARepo)).toEqual(before);
  });

  test("init applies at the root even when run from a subdirectory", () => {
    const root = fixtureRepo();
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(cli(nested, "init", "--yes", "--runtime", "global").status).toBe(0);
    expect(existsSync(join(root, ".sddx", "config.json"))).toBe(true);
    expect(existsSync(join(nested, ".sddx"))).toBe(false);
  });
});

describe("plan before mutation", () => {
  test("--dry-run prints the plan and leaves the tree byte-identical", () => {
    const root = fixtureRepo();
    const before = snapshot(root);
    const r = cli(root, "init", "--dry-run", "--runtime", "global", "--adapter", "claude");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(".sddx/config.json");
    expect(r.stdout).toContain("dry run: nothing was written");
    expect(snapshot(root)).toEqual(before);
  });

  test("the plan names every file, package operation, and config value", () => {
    const root = fixtureRepo();
    const plan = planInit(root, { ...OPTS, runtimeScope: "project", packageManager: "bun" });
    const paths = plan.files.map((f) => f.path);
    expect(paths).toContain(".sddx/config.json");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain(".sddx/receipts/.gitkeep");
    expect(plan.packageOps).toHaveLength(1);
    expect(plan.packageOps[0]!.command).toEqual(["bun", "add", "--dev", "@glapsfun/sddx"]);
    expect(plan.config.runtime_scope).toBe("project");
    expect(plan.config.schema_version).toBe("1.0");
  });

  test("JSON output carries the plan under the envelope's data key", () => {
    const root = fixtureRepo();
    const r = cli(root, "init", "--dry-run", "--runtime", "global", "--output", "json");
    expect(r.status).toBe(0);
    const envelope = JSON.parse(r.stdout) as {
      data: { plan: { files: unknown[]; config: Record<string, unknown> }; applied: boolean };
    };
    expect(envelope.data.applied).toBe(false);
    expect(Array.isArray(envelope.data.plan.files)).toBe(true);
    expect(envelope.data.plan.config.interaction_mode).toBe("human");
  });
});

describe("idempotence", () => {
  test("a second identical init reports no changes and rewrites nothing", () => {
    const root = fixtureRepo();
    expect(cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude").status).toBe(0);
    const after = snapshot(root);

    const second = cli(root, "init", "--yes", "--runtime", "global", "--adapter", "claude");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already initialized");
    expect(snapshot(root)).toEqual(after);
  });

  test("planIsNoop is true only once everything is in place", () => {
    const root = fixtureRepo();
    expect(planIsNoop(planInit(root, OPTS))).toBe(false);
    applyInit(planInit(root, OPTS));
    expect(planIsNoop(planInit(root, OPTS))).toBe(true);
  });
});

describe(".gitignore handling", () => {
  test("preserves user content and appends the block once", () => {
    const original = "node_modules/\n# my rules\n*.log\n";
    const once = withGitignoreBlock(original);
    expect(once.startsWith(original)).toBe(true);
    for (const p of EPHEMERAL_PATHS) expect(once).toContain(p);

    // re-running replaces the block rather than appending a second one
    const twice = withGitignoreBlock(once);
    expect(twice).toBe(once);
    expect(twice.match(/# sddx \(generated\)/g)).toHaveLength(1);
  });

  test("never ignores the whole .sddx tree", () => {
    const result = withGitignoreBlock("");
    const lines = result.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(lines).not.toContain(".sddx/");
    expect(lines).not.toContain(".sddx");
    // the tracked state directories stay tracked
    for (const tracked of ["specs", "tasks", "receipts", "goals", "adapters"]) {
      expect(result).not.toContain(`.sddx/${tracked}`);
    }
  });

  test("a file with no trailing newline is not corrupted", () => {
    const result = withGitignoreBlock("*.log");
    expect(result.startsWith("*.log\n")).toBe(true);
    expect(result).toContain(".sddx/local/");
  });

  test("git actually ignores the ephemeral paths and tracks the rest", () => {
    const root = fixtureRepo();
    applyInit(planInit(root, OPTS));
    const ignored = (p: string) =>
      spawnSync("git", ["check-ignore", "-q", p], { cwd: root }).status === 0;

    mkdirSync(join(root, ".sddx", "local"), { recursive: true });
    mkdirSync(join(root, ".sddx", "cache"), { recursive: true });
    writeFileSync(join(root, ".sddx", "local", "x.json"), "{}");
    writeFileSync(join(root, ".sddx", "cache", "y"), "");

    expect(ignored(".sddx/local/x.json")).toBe(true);
    expect(ignored(".sddx/cache/y")).toBe(true);
    expect(ignored(".sddx/config.json")).toBe(false);
    expect(ignored(".sddx/receipts/.gitkeep")).toBe(false);
  });
});

describe("apply ordering and rollback", () => {
  test("the package-manager step runs last, after every local file", () => {
    const root = fixtureRepo();
    const plan = planInit(root, { ...OPTS, runtimeScope: "project" });
    let filesPresentWhenPmRan = false;
    applyInit(plan, {
      runCommand: () => {
        filesPresentWhenPmRan = existsSync(join(root, ".sddx", "config.json"));
      },
    });
    expect(filesPresentWhenPmRan).toBe(true);
  });

  test("a failing package-manager step rolls the local files back", () => {
    const root = fixtureRepo();
    const before = snapshot(root);
    const plan = planInit(root, { ...OPTS, runtimeScope: "project" });

    expect(() =>
      applyInit(plan, {
        runCommand: () => {
          throw new Error("registry unreachable");
        },
      }),
    ).toThrow(InitApplyError);

    // every local file the apply had already written is gone again
    expect(snapshot(root)).toEqual(before);
  });

  test("a failing adapter step rolls back and reports what was undone", () => {
    const root = fixtureRepo();
    const before = snapshot(root);
    let caught: InitApplyError | null = null;
    try {
      applyInit(planInit(root, OPTS), {
        runAdapters: () => {
          throw new Error("collision at .claude/settings.json");
        },
      });
    } catch (e) {
      caught = e as InitApplyError;
    }
    expect(caught).toBeInstanceOf(InitApplyError);
    expect(caught!.message).toContain("collision");
    expect(caught!.rolledBack.length).toBeGreaterThan(0);
    expect(snapshot(root)).toEqual(before);
  });

  test("rollback restores a pre-existing .gitignore to its original bytes", () => {
    const root = fixtureRepo();
    const original = "# precious\nnode_modules/\n";
    writeFileSync(join(root, ".gitignore"), original);

    expect(() =>
      applyInit(planInit(root, OPTS), {
        runAdapters: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow(InitApplyError);

    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(original);
  });

  test("one stubborn undo step does not abandon the others", () => {
    const root = fixtureRepo();
    const plan = planInit(root, OPTS);
    applyInit(plan); // establish the files so a second apply takes the modify path

    // Two files must change on the replan, or there is only one undo step and
    // "kept going" is unfalsifiable: config.json (mode flips) and .gitignore
    // (the generated block is stripped, so it gets re-added).
    writeFileSync(join(root, ".gitignore"), "# user only\n");

    // Make one written file unwritable so its restore throws; the rollback must
    // still report it and keep going rather than stopping at the first failure.
    const stubborn = join(root, ".sddx", "config.json");
    let caught: InitApplyError | null = null;
    try {
      const replan = planInit(root, { ...OPTS, interactionMode: "auto" });
      expect(replan.files.filter((f) => f.kind !== "unchanged")).toHaveLength(2);
      applyInit(replan, {
        runAdapters: () => {
          chmodSync(stubborn, 0o444);
          throw new Error("boom");
        },
      });
    } catch (e) {
      caught = e as InitApplyError;
    } finally {
      chmodSync(stubborn, 0o644);
    }
    expect(caught).toBeInstanceOf(InitApplyError);
    // the unwritable file's undo is reported as failed...
    expect(caught!.rolledBack.some((s) => s.includes("FAILED"))).toBe(true);
    // ...and the rest of the log still ran rather than stopping at it
    expect(caught!.rolledBack.some((s) => !s.includes("FAILED"))).toBe(true);
  });
});

describe("non-interactive contract", () => {
  test("missing flags on a non-TTY fail fast with the exact flags named", () => {
    const root = fixtureRepo();
    const r = cli(root, "init"); // spawned: stdin is a pipe, never a TTY
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--runtime");
    expect(r.stderr).toContain("--yes");
    expect(existsSync(join(root, ".sddx", "config.json"))).toBe(false);
  });

  test("an invalid enum value is a usage error naming the accepted values", () => {
    const root = fixtureRepo();
    const r = cli(root, "init", "--yes", "--runtime", "sideways");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("global|project");
  });

  test("an unknown adapter is refused rather than silently skipped", () => {
    const root = fixtureRepo();
    const r = cli(root, "init", "--yes", "--runtime", "global", "--adapter", "emacs");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("emacs");
    expect(existsSync(join(root, ".sddx", "config.json"))).toBe(false);
  });

  test("the written config matches the flags exactly", () => {
    const root = fixtureRepo();
    expect(
      cli(root, "init", "--yes", "--runtime", "global", "--interaction-mode", "auto").status,
    ).toBe(0);
    const cfg = JSON.parse(readFileSync(join(root, ".sddx", "config.json"), "utf8"));
    expect(cfg).toEqual({
      schema_version: "1.0",
      interaction_mode: "auto",
      runtime_scope: "global",
      package_manager: "npm",
      adapters: [],
    });
  });
});
