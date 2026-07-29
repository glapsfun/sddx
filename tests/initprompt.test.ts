// The interactive initializer. The prompts themselves need a TTY, so what is
// asserted here is everything that must hold AROUND them: the non-TTY refusal,
// the zero-mutation cancel, that both paths converge on one core, and that the
// published package still declares no runtime dependencies.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { applyInit, type InitOptions, planInit } from "../src/lib/init";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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

describe("non-TTY never prompts", () => {
  test("a piped stdin fails fast instead of waiting for input", () => {
    // spawnSync gives the child a pipe, not a TTY — the CI shape exactly.
    const root = fixtureRepo();
    const r = cli(root, "init");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not an interactive terminal");
    expect(existsSync(join(root, ".sddx", "config.json"))).toBe(false);
  });

  test("--output json never prompts even if a TTY is somehow attached", () => {
    // A machine-readable run must stay machine-readable: a prompt would corrupt
    // the envelope on stdout as well as block.
    const root = fixtureRepo();
    const r = cli(root, "init", "--dry-run", "--runtime", "global", "--output", "json");
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("both paths converge on the bootstrap core", () => {
  test("choices collected interactively and via flags produce identical results", () => {
    // The interactive path's only job is to produce an InitOptions; applying
    // that object is what the flag path does too. Asserting on the object is
    // asserting the convergence.
    const opts: InitOptions = {
      runtimeScope: "global",
      packageManager: "npm",
      adapters: [],
      interactionMode: "auto",
    };

    const viaCore = fixtureRepo();
    applyInit(planInit(viaCore, opts));

    const viaFlags = fixtureRepo();
    expect(
      cli(viaFlags, "init", "--yes", "--runtime", "global", "--interaction-mode", "auto").status,
    ).toBe(0);

    expect(snapshot(viaFlags)).toEqual(snapshot(viaCore));
  });
});

describe("cancellation", () => {
  test("a declined plan is byte-identical to a dry run", () => {
    // Cancelling is not a special path — it is the plan simply never applied.
    const declined = fixtureRepo();
    const before = snapshot(declined);
    expect(
      cli(declined, "init", "--dry-run", "--runtime", "global", "--adapter", "claude").status,
    ).toBe(0);
    expect(snapshot(declined)).toEqual(before);
  });

  test("no package-manager command runs when the plan is not applied", () => {
    const root = fixtureRepo();
    const r = cli(root, "init", "--dry-run", "--runtime", "project", "--package-manager", "npm");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("npm install --save-dev @glapsfun/sddx");
    // ...planned, and not run: no lockfile, no node_modules
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });
});

describe("zero runtime dependencies", () => {
  test("the published manifest declares no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    // the prompt library is a build-time dependency, bundled into dist
    expect(pkg.devDependencies["@clack/prompts"]).toBeDefined();
  });

  test("the built bundle imports nothing outside node: builtins", () => {
    const bundle = readFileSync(join(repoRoot, "dist/cli.mjs"), "utf8");
    const specifiers = [...bundle.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1] as string);
    expect(specifiers.length).toBeGreaterThan(0);
    const external = specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("."));
    expect(external).toEqual([]);
  });
});
