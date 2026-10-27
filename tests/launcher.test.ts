import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, runsCleanly } from "./helpers";
import { toolDir } from "./hook-launcher";
import { scenario } from "./scenario";

test("launcher shim runs the dist bundle under bun", async () => {
  await runsCleanly(["bin/sddx-run", "dist/bootstrap.mjs"]);
});

test("launcher refuses when bun is absent, naming bun and how to install it", async () => {
  // A PATH holding node but not bun: the old launcher silently succeeded here.
  // Bun-only means this must fail loudly rather than fall back.
  const nodeBin = Bun.which("node");
  if (!nodeBin) throw new Error("node not found on PATH");
  const nodeOnlyDir = mkdtempSync(join(tmpdir(), "sddx-nodeonly-"));
  symlinkSync(nodeBin, join(nodeOnlyDir, "node"));

  const proc = Bun.spawn([join(repoRoot, "bin/sddx-run"), "dist/bootstrap.mjs"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: nodeOnlyDir },
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("bun is required");
  expect(stderr).toContain("bun.sh");
  // No fallback was attempted: nothing ran, so nothing was written to stdout.
  expect(await new Response(proc.stdout).text()).toBe("");
});

test("launcher without a script argument is a usage error", async () => {
  const proc = Bun.spawn([join(repoRoot, "bin/sddx-run")], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(64);
  expect(await new Response(proc.stderr).text()).toContain("usage:");
});

describe("bin/sddx as the plugin ships it", () => {
  scenario("claude-plugin", "Launcher runs the bundle beside it", () => {
    // Claude Code copies the plugin to its own cache; the launcher must find the
    // bundle next to itself there, not in this checkout
    const copy = mkdtempSync(join(tmpdir(), "plugin-copy-"));
    for (const p of ["bin", "dist", "package.json", ".claude-plugin"]) {
      cpSync(join(repoRoot, p), join(copy, p), { recursive: true });
    }
    const r = spawnSync(join(copy, "bin/sddx"), ["--version"], { cwd: tmpdir(), encoding: "utf8" });
    const manifest = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin/plugin.json"), "utf8"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(manifest.version);
  });

  scenario("claude-plugin", "Launcher without Bun", () => {
    const r = spawnSync(join(repoRoot, "bin/sddx"), ["--version"], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        PATH: toolDir(["dirname", "readlink"]),
        HOME: mkdtempSync(join(tmpdir(), "home-")),
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
  });
});
