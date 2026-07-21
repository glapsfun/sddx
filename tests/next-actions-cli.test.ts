import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  // explicit env: Bun's spawnSync does not pick up a runtime-mutated
  // process.env (e.g. a PATH prepended in a test's beforeEach) unless it's
  // passed explicitly — it otherwise inherits the env snapshot from startup
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env: process.env });
}

describe("sddx next-actions", () => {
  test("menu rendering: uncommitted state", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    const r = cli(cwd, "next-actions");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Next Actions");
    expect(r.stdout).toContain("1. Commit");
    expect(r.stdout).toContain("Commit & Push");
    expect(r.stdout).not.toMatch(/\d+\. Push\b/); // plain "Push" (committed-unpushed-only) absent
    expect(r.stdout).not.toContain("Merge Branch");
  });

  test("menu rendering: committed-unpushed state", () => {
    const cwd = fixtureRepo(); // clean tree, no upstream
    const r = cli(cwd, "next-actions");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Push");
    expect(r.stdout).toContain("Create PR/MR");
    expect(r.stdout).toContain("Merge Branch");
    expect(r.stdout).not.toContain("Commit\n");
  });

  test("successful execution + result reporting: Commit", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    const r = cli(cwd, "next-actions", "--select", "1");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("committed");
    const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    expect(status.stdout.trim()).toBe("");
  });

  test("successful execution + result reporting: natural-language 'commit'", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    const r = cli(cwd, "next-actions", "--select", "commit");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("committed");
  });

  test("refusal on stale selection: committing after the tree was already cleaned", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    // menu would show "Commit" as option 1 for this dirty tree — but the
    // caller acts on a stale reply after discarding the change out-of-band
    spawnSync("git", ["checkout", "--", "."], { cwd });
    spawnSync("git", ["clean", "-fd"], { cwd });
    const r = cli(cwd, "next-actions", "--select", "commit");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("isn't a valid action right now");
  });

  test("refusal on unmatched input", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    const r = cli(cwd, "next-actions", "--select", "launch the rocket");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("isn't a valid action right now");
  });

  test("Show Git Diff reports the diff", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "README.md"), "fixture\nchanged\n");
    const r = cli(cwd, "next-actions", "--select", "Show Git Diff");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("changed");
  });

  test("Discard Changes removes uncommitted edits", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "untracked.txt"), "x\n");
    writeFileSync(join(cwd, "README.md"), "fixture\nchanged\n");
    const r = cli(cwd, "next-actions", "--select", "Discard Changes");
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, "untracked.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("fixture\n");
  });
});

describe("sddx next-actions PR host execution", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "sddx-fakebin-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function fakeCli(name: string, script: string): void {
    const path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  test("Create PR/MR on a GitHub remote", () => {
    const { clone } = fixtureClone();
    spawnSync("git", ["remote", "set-url", "origin", "https://github.com/org/repo.git"], {
      cwd: clone,
    });
    fakeCli(
      "gh",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/org/repo/pull/9"; exit 0; fi\nexit 1',
    );
    const r = cli(clone, "next-actions", "--select", "Create PR/MR");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://github.com/org/repo/pull/9");
  });

  test("Create PR/MR on a GitLab remote", () => {
    const { clone } = fixtureClone();
    spawnSync("git", ["remote", "set-url", "origin", "https://gitlab.com/org/repo.git"], {
      cwd: clone,
    });
    fakeCli(
      "glab",
      'if [ "$1" = "mr" ] && [ "$2" = "create" ]; then echo "https://gitlab.com/org/repo/-/merge_requests/3"; exit 0; fi\nexit 1',
    );
    const r = cli(clone, "next-actions", "--select", "Create PR/MR");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://gitlab.com/org/repo/-/merge_requests/3");
  });
});
