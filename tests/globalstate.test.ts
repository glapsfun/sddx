// Optional user-global state. The tests are mostly about what must NOT happen:
// no collisions, no cross-project leakage, no lifecycle dependence.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalRoot,
  projectDir,
  projectKey,
  readMemory,
  rememberProject,
  writeMemory,
} from "../src/lib/globalstate";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

/** An isolated `~/.sddx` per test — nothing here touches the real home. */
function sddxHome(): NodeJS.ProcessEnv {
  return { SDDX_HOME: mkdtempSync(join(tmpdir(), "sddx-home-")) };
}

const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

describe("project key derivation", () => {
  test("two repositories with the same directory name get different keys", () => {
    // The failure this prevents: every project called `api` sharing one memory.
    const base = mkdtempSync(join(tmpdir(), "sddx-same-"));
    const keys = new Set<string>();
    for (const n of ["one", "two"]) {
      const dir = join(base, n, "api");
      spawnSync("mkdir", ["-p", dir]);
      g(dir, "init", "-q", "-b", "main");
      keys.add(projectKey(dir).key);
    }
    expect(keys.size).toBe(2);
  });

  test("the key is stable across two clones of the same repository", () => {
    const { origin, clone } = fixtureClone();
    const second = mkdtempSync(join(tmpdir(), "sddx-clone2-"));
    const dir = join(second, "again");
    expect(g(second, "clone", "-q", origin, dir).status).toBe(0);

    expect(projectKey(dir).key).toBe(projectKey(clone).key);
    expect(projectKey(clone).source).toBe("remote");
  });

  test("clone URL spelling does not change the key", () => {
    // ssh vs https vs scp-style vs a trailing .git are the same repository.
    const forms = [
      "https://github.com/glapsfun/sddx.git",
      "git@github.com:glapsfun/sddx.git",
      "ssh://git@github.com/glapsfun/sddx",
      "https://user:token@github.com/glapsfun/sddx",
    ];
    const keys = new Set<string>();
    for (const url of forms) {
      const dir = fixtureRepo();
      g(dir, "remote", "add", "origin", url);
      keys.add(projectKey(dir).key);
    }
    expect(keys.size).toBe(1);
  });

  test("a repository with no remote falls back to its first commit", () => {
    const dir = fixtureRepo();
    const { source, key } = projectKey(dir);
    expect(source).toBe("first-commit");
    expect(key).toMatch(/-[0-9a-f]{12}$/);
  });

  test("the key stays human-recognizable", () => {
    const dir = fixtureRepo();
    g(dir, "remote", "add", "origin", "https://github.com/glapsfun/my-service.git");
    expect(projectKey(dir).key.startsWith("my-service-")).toBe(true);
  });
});

describe("privacy", () => {
  test("the directory and its files are owner-only", () => {
    const env = sddxHome();
    const root = fixtureRepo();
    rememberProject(root, env);

    const dir = projectDir(root, env);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "metadata.json")).mode & 0o777).toBe(0o600);
  });

  test("nothing is written outside the global root", () => {
    const env = sddxHome();
    const root = fixtureRepo();
    rememberProject(root, env);
    writeMemory(root, "some notes", env);
    expect(projectDir(root, env).startsWith(globalRoot(env))).toBe(true);
  });

  test("no credentials or transcripts are written by normal operation", () => {
    const env = sddxHome();
    const root = fixtureRepo();
    rememberProject(root, env);
    const metadata = readFileSync(join(projectDir(root, env), "metadata.json"), "utf8");
    // The record is deliberately dull: identity and a path, nothing else.
    expect(Object.keys(JSON.parse(metadata)).sort()).toEqual([
      "key_source",
      "last_known_path",
      "project_key",
      "schema_version",
    ]);
  });
});

describe("memory provenance", () => {
  test("memory carries the project it belongs to", () => {
    const env = sddxHome();
    const root = fixtureRepo();
    expect(writeMemory(root, "remember this", env)).toBe(true);
    const body = readFileSync(join(projectDir(root, env), "memory.md"), "utf8");
    expect(body).toContain(projectKey(root).key);
    expect(readMemory(root, env)).toContain("remember this");
  });

  test("memory from another project is not loaded", () => {
    // Provenance is checked on read: a file copied or moved into this
    // project's directory must not be treated as this project's memory.
    const env = sddxHome();
    const projectA = fixtureRepo();
    const projectB = fixtureRepo();
    writeMemory(projectA, "A's private notes", env);
    writeMemory(projectB, "B's own notes", env); // so B's directory exists

    const stolen = readFileSync(join(projectDir(projectA, env), "memory.md"), "utf8");
    writeFileSync(join(projectDir(projectB, env), "memory.md"), stolen);

    expect(readMemory(projectB, env)).toBeNull();
    expect(readMemory(projectA, env)).toContain("A's private notes");
  });

  test("absent memory reads as null, not an error", () => {
    expect(readMemory(fixtureRepo(), sddxHome())).toBeNull();
  });
});

describe("never required for correctness", () => {
  test("an unwritable global root degrades instead of throwing", () => {
    const env = { SDDX_HOME: "/proc/nonexistent/sddx" };
    const root = fixtureRepo();
    expect(rememberProject(root, env)).toBeNull();
    expect(writeMemory(root, "x", env)).toBe(false);
    expect(readMemory(root, env)).toBeNull();
  });

  test("no lifecycle code reads user-global state", () => {
    // The strongest available form of "never required for correctness": the
    // gates, phase machine, verifier, and receipt writer cannot depend on
    // `~/.sddx` because they never reference it. Only this module and the
    // command that populates it may.
    // Every module that decides, gates, or records a task's fate.
    const lifecycle = [
      "src/lib/task.ts",
      "src/lib/verify.ts",
      "src/lib/receipt.ts",
      "src/lib/recorder.ts",
      "src/lib/stopgate.ts",
      "src/lib/bashgate.ts",
      "src/lib/approvalgate.ts",
      "src/lib/redcheck.ts",
      "src/lib/oracle.ts",
      "src/lib/worktree.ts",
      "src/lib/graph.ts",
      "src/lib/goal.ts",
      "src/tdd-gate.ts",
      "src/lib/hookdispatch.ts",
    ];
    for (const rel of lifecycle) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, `${rel} must not reach for user-global state`).not.toContain("globalstate");
      expect(src, `${rel} must not read SDDX_HOME`).not.toContain("SDDX_HOME");
    }
  });

  test("init still succeeds when the global root cannot be written", () => {
    const root = fixtureRepo();
    const r = spawnSync(
      "bun",
      [join(repoRoot, "src/cli.ts"), "init", "--yes", "--runtime", "global"],
      { cwd: root, encoding: "utf8", env: { ...process.env, SDDX_HOME: "/proc/nope/sddx" } },
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(root, ".sddx", "config.json"))).toBe(true);
  });
});
