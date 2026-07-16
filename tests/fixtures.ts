import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sddx-fixture-"));
  const g = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "fixture@example.invalid");
  g("config", "user.name", "fixture");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}
