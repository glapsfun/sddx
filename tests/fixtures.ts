import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bare origin + clone whose origin/HEAD resolves locally. Returns the clone path. */
export function fixtureClone(): { origin: string; clone: string } {
  const base = mkdtempSync(join(tmpdir(), "sddx-clone-"));
  const origin = join(base, "origin.git");
  const seed = fixtureRepo();
  const g = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  g(base, "clone", "-q", "--bare", seed, origin);
  const clone = join(base, "clone");
  g(base, "clone", "-q", origin, clone);
  g(clone, "config", "user.email", "fixture@example.invalid");
  g(clone, "config", "user.name", "fixture");
  g(clone, "config", "commit.gpgsign", "false");
  return { origin, clone };
}

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

/** fixtureRepo plus a throwaway SSH signing identity wired into git config. */
export function signingRepo(): string {
  const cwd = fixtureRepo();
  const keyDir = mkdtempSync(join(tmpdir(), "sddx-key-"));
  const key = join(keyDir, "id_ed25519");
  const kg = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]);
  if (kg.status !== 0) throw new Error(`ssh-keygen failed: ${kg.stderr}`);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  const allowed = join(keyDir, "allowed_signers");
  writeFileSync(allowed, `fixture@example.invalid ${pub}\n`);
  for (const [k, v] of [
    ["gpg.format", "ssh"],
    ["user.signingkey", key],
    ["gpg.ssh.allowedSignersFile", allowed],
  ] as const) {
    spawnSync("git", ["config", k, v], { cwd });
  }
  return cwd;
}

/** Writes a v6 `.sddx/config.json` with the given keys. */
export function writeConfig(cwd: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    `${JSON.stringify({ schema_version: "2.0", ...cfg }, null, 2)}\n`,
  );
}
