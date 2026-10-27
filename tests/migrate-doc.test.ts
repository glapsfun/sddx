import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, repoRoot } from "./helpers";
import { extractV5Fixture } from "./v5-fixture";

const doc = readFileSync(join(repoRoot, "docs", "how-to", "migrate-to-v6.md"), "utf8");
const blocks = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

test("docs/how-to/migrate-to-v6.md replays against a real sddx 5 repository", () => {
  const { dir, ids } = extractV5Fixture();
  // step 1 of the guide, done the way sddx 5 would: close out the in-flight task
  const path = join(
    dir,
    ".sddx-worktrees",
    ids.redTaskId,
    ".sddx",
    "tasks",
    `${ids.redTaskId}.json`,
  );
  const t = JSON.parse(readFileSync(path, "utf8"));
  t.phase = "ABANDONED";
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);

  const bin = mkdtempSync(join(tmpdir(), "sddx-shim-"));
  writeFileSync(join(bin, "sddx"), `#!/bin/sh\nexec bun "${CLI}" "$@"\n`);
  chmodSync(join(bin, "sddx"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1" };

  expect(blocks.length).toBeGreaterThanOrEqual(4);
  for (const block of blocks) {
    const r = spawnSync("sh", ["-ec", block], { cwd: dir, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`block failed:\n${block}\n${r.stdout}\n${r.stderr}`);
  }
  const doctor = spawnSync("sh", ["-c", "sddx doctor"], { cwd: dir, env, encoding: "utf8" });
  expect(doctor.stdout).toContain("PASS v5-leftovers");
  expect(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout).toBe(
    "",
  );
});
