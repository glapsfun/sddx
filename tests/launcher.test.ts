import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, runsCleanly } from "./helpers";

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
