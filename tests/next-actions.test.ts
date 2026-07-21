import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, stageAll } from "../src/lib/git";
import {
  type Action,
  CATALOG,
  detectState,
  renderMenu,
  resolveSelection,
  visibleActions,
} from "../src/lib/next-actions";
import { fixtureClone, fixtureRepo } from "./fixtures";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

describe("detectState", () => {
  test("uncommitted changes", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "dirty.txt"), "x\n");
    expect(detectState(cwd).state).toBe("uncommitted");
  });

  test("clean tree, no upstream at all", () => {
    const cwd = fixtureRepo();
    expect(detectState(cwd).state).toBe("committed-unpushed");
  });

  test("clean tree, ahead of upstream", () => {
    const { clone } = fixtureClone();
    writeFileSync(join(clone, "extra.txt"), "x\n");
    stageAll(clone);
    commit(clone, "extra");
    expect(detectState(clone).state).toBe("committed-unpushed");
  });

  test("pushed, host unresolvable falls back to pushed-no-pr with a warning", () => {
    const { clone } = fixtureClone();
    // fixtureClone's origin is a local bare repo path, not github.com/gitlab.com
    const res = detectState(clone);
    expect(res.state).toBe("pushed-no-pr");
    expect(res.warning).toMatch(/PR host/);
  });
});

describe("detectState with a fake PR host CLI", () => {
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

  function githubClone() {
    const { origin, clone } = fixtureClone();
    g(clone, "remote", "set-url", "origin", "https://github.com/org/repo.git");
    return { origin, clone };
  }

  test("host authenticated, no open PR → pushed-no-pr, no warning", () => {
    const { clone } = githubClone();
    fakeCli("gh", 'echo "Logged in to github.com"; exit 0');
    // overwrite gh so auth status passes for the first call and pr view fails
    fakeCli(
      "gh",
      'if [ "$1" = "auth" ]; then echo "Logged in to github.com"; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "no pull requests found" >&2; exit 1; fi\nexit 1',
    );
    const res = detectState(clone);
    expect(res.state).toBe("pushed-no-pr");
    expect(res.warning).toBeNull();
  });

  test("host authenticated, open PR found → pr-open", () => {
    const { clone } = githubClone();
    fakeCli(
      "gh",
      'if [ "$1" = "auth" ]; then echo "Logged in to github.com"; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "{\\"url\\":\\"https://github.com/org/repo/pull/1\\"}"; exit 0; fi\nexit 1',
    );
    const res = detectState(clone);
    expect(res.state).toBe("pr-open");
    expect(res.warning).toBeNull();
  });

  test("host auth failure → pushed-no-pr with a warning, not a hard failure", () => {
    const { clone } = githubClone();
    fakeCli("gh", 'if [ "$1" = "auth" ]; then echo "not logged in" >&2; exit 1; fi\nexit 1');
    const res = detectState(clone);
    expect(res.state).toBe("pushed-no-pr");
    expect(res.warning).toMatch(/not authenticated/);
  });
});

describe("visibleActions / renderMenu", () => {
  test("uncommitted state shows exactly the documented set", () => {
    const labels = visibleActions("uncommitted").map((a) => a.label);
    expect(labels).toEqual([
      "Commit",
      "Commit & Push",
      "Continue Working",
      "Show Git Diff",
      "Run Tests",
      "Discard Changes",
      "Exit",
    ]);
  });

  test("committed-unpushed state shows exactly the documented set", () => {
    const labels = visibleActions("committed-unpushed").map((a) => a.label);
    expect(labels).toEqual(["Push", "Create PR/MR", "Merge Branch", "Continue Working", "Exit"]);
  });

  test("pushed-no-pr state shows exactly the documented set", () => {
    const labels = visibleActions("pushed-no-pr").map((a) => a.label);
    expect(labels).toEqual(["Create PR/MR", "Continue Working", "Exit"]);
  });

  test("pr-open state shows exactly the documented set", () => {
    const labels = visibleActions("pr-open").map((a) => a.label);
    expect(labels).toEqual(["Merge to Main", "Continue Working", "Start Next Task", "Exit"]);
  });

  test("no invalid action ever appears for a state", () => {
    for (const state of ["uncommitted", "committed-unpushed", "pushed-no-pr", "pr-open"] as const) {
      for (const action of visibleActions(state)) {
        expect(action.validIn).toContain(state);
      }
    }
  });

  test("unimplemented future catalog entries never render", () => {
    const future = CATALOG.filter((a) => !a.implemented);
    expect(future.length).toBeGreaterThan(0);
    for (const state of ["uncommitted", "committed-unpushed", "pushed-no-pr", "pr-open"] as const) {
      const visibleIds = visibleActions(state).map((a) => a.id);
      for (const f of future) expect(visibleIds).not.toContain(f.id);
    }
  });

  test("renderMenu numbers actions sequentially by category", () => {
    const text = renderMenu(visibleActions("uncommitted"));
    expect(text).toContain("1. Commit");
    expect(text).toContain("2. Commit & Push");
    expect(text).toContain("Reply with the action number or simply type the action name.");
  });
});

describe("resolveSelection", () => {
  const A: Action = { id: "a", label: "Alpha", category: "git", validIn: [], implemented: true };
  const B: Action = {
    id: "b",
    label: "Beta",
    category: "git",
    validIn: [],
    aliases: ["shared"],
    implemented: true,
  };
  const C: Action = {
    id: "c",
    label: "Gamma",
    category: "git",
    validIn: [],
    aliases: ["shared"],
    implemented: true,
  };
  const visible = [A, B];

  test("numeric selection", () => {
    expect(resolveSelection("1", visible)).toBe(A);
    expect(resolveSelection("2", visible)).toBe(B);
  });

  test("label match is case-insensitive", () => {
    expect(resolveSelection("alpha", visible)).toBe(A);
    expect(resolveSelection("BETA", visible)).toBe(B);
  });

  test("alias match", () => {
    expect(resolveSelection("shared", visible)).toBe(B);
  });

  test("selection not currently visible is refused", () => {
    const res = resolveSelection("gamma", visible);
    expect(res).toEqual({ error: "not-found" });
    expect(resolveSelection("3", visible)).toEqual({ error: "not-found" });
  });

  test("ambiguous free text is refused", () => {
    const res = resolveSelection("shared", [B, C]);
    expect(res).toEqual({ error: "ambiguous" });
  });
});
