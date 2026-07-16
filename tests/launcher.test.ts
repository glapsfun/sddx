import { test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, runsCleanly } from "./helpers";

test("launcher shim runs the dist bundle", async () => {
  await runsCleanly(["bin/sddx-run", "dist/bootstrap.mjs"]);
});

test("dist bundle runs under plain node (fallback path)", async () => {
  await runsCleanly(["node", "dist/bootstrap.mjs"]);
});

test("launcher falls back to node when bun is not on PATH", async () => {
  const nodeBin = Bun.which("node");
  if (!nodeBin) throw new Error("node not found on PATH");
  const nodeOnlyDir = mkdtempSync(join(tmpdir(), "sddx-nodeonly-"));
  symlinkSync(nodeBin, join(nodeOnlyDir, "node"));
  await runsCleanly([join(repoRoot, "bin/sddx-run"), "dist/bootstrap.mjs"], {
    PATH: nodeOnlyDir,
  });
});
