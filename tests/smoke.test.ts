import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, repoRoot, userEnv } from "./helpers";

test("scripts/smoke.sh, which CI runs against the packed tarball, passes from source", () => {
  const bin = mkdtempSync(join(tmpdir(), "sddx-smoke-bin-"));
  writeFileSync(join(bin, "sddx"), `#!/bin/sh\nexec bun "${CLI}" "$@"\n`);
  chmodSync(join(bin, "sddx"), 0o755);
  const r = spawnSync("sh", [join(repoRoot, "scripts", "smoke.sh")], {
    encoding: "utf8",
    env: userEnv({ PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1" }),
  });
  if (r.status !== 0) throw new Error(`${r.stdout}\n${r.stderr}`);
  expect(r.stdout).toContain("smoke: ok");
  expect(r.stdout).toContain("1 receipt(s) verified, chain intact");
}, 120_000);
