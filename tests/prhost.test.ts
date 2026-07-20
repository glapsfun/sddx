import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghBackend, glabBackend, resolveBackend } from "../src/lib/prhost";
import { fixtureRepo } from "./fixtures";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

function withFakeConfig(cwd: string, prHost: "gh" | "glab"): void {
  const dir = join(cwd, ".sddx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ pr_host: prHost }));
}

describe("resolveBackend", () => {
  test("userConfig.pr_host overrides remote detection", () => {
    const cwd = fixtureRepo();
    g(cwd, "remote", "add", "origin", "https://gitlab.com/org/repo.git");
    withFakeConfig(cwd, "gh");
    expect(resolveBackend(cwd).name).toBe("gh");
  });

  test("github.com origin resolves to gh", () => {
    const cwd = fixtureRepo();
    g(cwd, "remote", "add", "origin", "https://github.com/org/repo.git");
    expect(resolveBackend(cwd).name).toBe("gh");
  });

  test("gitlab.com origin resolves to glab", () => {
    const cwd = fixtureRepo();
    g(cwd, "remote", "add", "origin", "git@gitlab.com:org/repo.git");
    expect(resolveBackend(cwd).name).toBe("glab");
  });

  test("ambiguous or missing remote refuses and names pr_host", () => {
    const cwd = fixtureRepo();
    g(cwd, "remote", "add", "origin", "https://example.internal/org/repo.git");
    expect(() => resolveBackend(cwd)).toThrow(/pr_host/);
  });

  test("no remote at all refuses", () => {
    const cwd = fixtureRepo();
    expect(() => resolveBackend(cwd)).toThrow(/pr_host/);
  });

  test("an invalid pr_host value in config.json throws a clear error, not a TypeError", () => {
    const cwd = fixtureRepo();
    const dir = join(cwd, ".sddx");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ pr_host: "hub" }));
    expect(() => resolveBackend(cwd)).toThrow(/pr_host is "hub"/);
  });
});

describe("backend CLI interaction", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "sddx-fakebin-"));
    originalPath = process.env.PATH;
    // isolated on purpose: only `binDir` is searched, so a real gh/glab
    // installed on the dev machine can never leak into these tests
    process.env.PATH = binDir;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function fakeCli(name: string, script: string): void {
    const path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  test("gh authStatus surfaces failure verbatim from the CLI", () => {
    fakeCli("gh", 'echo "not logged in to any hosts" >&2; exit 1');
    const status = ghBackend.authStatus(process.cwd());
    expect(status.ok).toBe(false);
    expect(status.message).toContain("not logged in to any hosts");
  });

  test("gh authStatus ok on success", () => {
    fakeCli("gh", 'echo "Logged in to github.com as octocat"; exit 0');
    expect(ghBackend.authStatus(process.cwd()).ok).toBe(true);
  });

  test("gh authStatus reports missing CLI distinctly from an auth failure", () => {
    // no fake `gh` on PATH at all
    const status = ghBackend.authStatus(process.cwd());
    expect(status.ok).toBe(false);
    expect(status.message).toContain("not found");
  });

  test("gh openPr returns the printed PR URL", () => {
    fakeCli("gh", 'echo "https://github.com/org/repo/pull/42"; exit 0');
    const url = ghBackend.openPr(process.cwd(), {
      branch: "sddx/goal-x",
      title: "t",
      body: "b",
    });
    expect(url).toBe("https://github.com/org/repo/pull/42");
  });

  test("gh openPr throws with the CLI's stderr on failure", () => {
    fakeCli("gh", 'echo "pull request create failed: branch not found" >&2; exit 1');
    expect(() =>
      ghBackend.openPr(process.cwd(), { branch: "sddx/goal-x", title: "t", body: "b" }),
    ).toThrow(/branch not found/);
  });

  test("glab authStatus and openPr follow the same contract", () => {
    fakeCli("glab", 'echo "glab: Logged in to gitlab.com"; exit 0');
    expect(glabBackend.authStatus(process.cwd()).ok).toBe(true);

    fakeCli("glab", 'echo "https://gitlab.com/org/repo/-/merge_requests/7"; exit 0');
    const url = glabBackend.openPr(process.cwd(), {
      branch: "sddx/goal-x",
      title: "t",
      body: "b",
    });
    expect(url).toBe("https://gitlab.com/org/repo/-/merge_requests/7");
  });
});
