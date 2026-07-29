// Worktree preconditions must be precise, because they are now fatal.
//
// While a branch-mode fallback existed, a false-positive precondition cost the
// user a degraded mode. The canonical run lifecycle removes the fallback, so
// the same false positive costs them the tool. Both existing checks were
// coarser than the thing they were protecting against:
//
//   worktreeAvailable  refused whenever git-dir !== git-common-dir, which means
//                      only "sddx was invoked from inside a linked worktree" —
//                      including one sddx itself created. `git worktree add`
//                      against the main repo root works fine from there.
//
//   hasSubmodules      refused on the mere existence of .gitmodules, so one
//                      vendored submodule disqualified the whole repository
//                      forever, regardless of what any task touched. sddx
//                      already knows what each task touches: `scope`.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWorktree,
  submodulePaths,
  submoduleScopeConflicts,
  worktreeAvailable,
} from "../src/lib/worktree";
import { fixtureRepo } from "./fixtures";
import { GRAPH_HEADER, goalIds } from "./helpers";

const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const head = (cwd: string) => g(cwd, "rev-parse", "HEAD").stdout.trim();

/** Commit a `.gitmodules` declaring `paths` — enough to exercise every read the
 * precondition performs, which is a `cat-file` of that file at the base SHA. */
function withGitmodules(cwd: string, paths: string[]): string {
  const body = paths
    .map((p) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = https://example.invalid/${p}.git\n`)
    .join("");
  writeFileSync(join(cwd, ".gitmodules"), body);
  g(cwd, "add", "-A");
  g(cwd, "commit", "-qm", "add submodules");
  return head(cwd);
}

describe("worktree availability", () => {
  test("available in an ordinary repository", () => {
    expect(worktreeAvailable(fixtureRepo())).toBe(true);
  });

  test("still available from INSIDE a linked worktree", () => {
    // The old check refused here. Being in a linked worktree says nothing about
    // whether git can add another one against the main repository root — and
    // sddx puts its own agents inside linked worktrees, so this refused sddx
    // running from the very workspaces it created.
    const repo = fixtureRepo();
    const linked = join(repo, "..", `linked-${Date.now() % 100000}`);
    expect(g(repo, "worktree", "add", "-q", linked, "-b", "side").status).toBe(0);

    expect(worktreeAvailable(linked)).toBe(true);
  });

  test("a worktree created from inside a linked worktree lands under the MAIN repo root", () => {
    const repo = fixtureRepo();
    const linked = join(repo, "..", `linked2-${Date.now() % 100000}`);
    expect(g(repo, "worktree", "add", "-q", linked, "-b", "side2").status).toBe(0);

    const path = createWorktree(linked, "some-task", head(repo));
    // realpath both sides: on macOS the fixture lives under /var, a symlink to
    // /private/var, and git reports the resolved form
    expect(realpathSync(path)).toBe(realpathSync(join(repo, ".sddx-worktrees", "some-task")));
    expect(existsSync(path)).toBe(true);
  });

  test("unavailable when git genuinely cannot list worktrees", () => {
    const notARepo = fixtureRepo();
    expect(worktreeAvailable(join(notARepo, "..", "definitely-not-a-repo"))).toBe(false);
  });
});

describe("submodule preconditions are scope-scoped", () => {
  test("no .gitmodules means no submodule paths", () => {
    const repo = fixtureRepo();
    expect(submodulePaths(repo, head(repo))).toEqual([]);
  });

  test("declared submodule paths are read from the base SHA", () => {
    const repo = fixtureRepo();
    const sha = withGitmodules(repo, ["vendor/lib", "third_party/thing"]);
    expect(submodulePaths(repo, sha).sort()).toEqual(["third_party/thing", "vendor/lib"]);
  });

  test("a submodule outside every task scope does not conflict", () => {
    const repo = fixtureRepo();
    const sha = withGitmodules(repo, ["vendor/lib"]);
    const conflicts = submoduleScopeConflicts(repo, sha, [
      { alias: "a", scope: ["src/**"] },
      { alias: "b", scope: ["docs/**"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("a task scope crossing a submodule conflicts, naming task and path", () => {
    const repo = fixtureRepo();
    const sha = withGitmodules(repo, ["vendor/lib"]);
    const conflicts = submoduleScopeConflicts(repo, sha, [
      { alias: "a", scope: ["src/**"] },
      { alias: "b", scope: ["vendor/lib/**"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.alias).toBe("b");
    expect(conflicts[0]?.submodule).toBe("vendor/lib");
  });

  test("a SCOPELESS task in a submodule repository conflicts", () => {
    // An undeclared write lane cannot be proven disjoint from the submodule
    // path, and the whole narrowing rests on that proof. Same stance the
    // autonomy bounds take toward an unconfined scope.
    const repo = fixtureRepo();
    const sha = withGitmodules(repo, ["vendor/lib"]);
    const conflicts = submoduleScopeConflicts(repo, sha, [{ alias: "a", scope: [] }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.alias).toBe("a");
  });

  test("a scopeless task in a repository WITHOUT submodules does not conflict", () => {
    const repo = fixtureRepo();
    expect(submoduleScopeConflicts(repo, head(repo), [{ alias: "a", scope: [] }])).toEqual([]);
  });
});

describe("the canonical create path refuses rather than downgrading", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

  function planWithScope(cwd: string, scope: string | null): string {
    mkdirSync(join(cwd, "specs"), { recursive: true });
    writeFileSync(
      join(cwd, "specs", "a.yaml"),
      `task: do the widget work\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n${scope ? `scope:\n  - ${scope}\n` : ""}`,
    );
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: ship the widget\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n`,
    );
    return "graph.yaml";
  }

  test("a submodule outside every scope materializes normally", () => {
    const repo = fixtureRepo();
    withGitmodules(repo, ["vendor/lib"]);
    const rel = planWithScope(repo, "src/**");
    expect(cli(repo, "graph", "approve", "--graph", rel).status).toBe(0);
    const r = cli(repo, "graph", "create", "--graph", rel);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("branch mode");
  });

  test("a scope crossing a submodule refuses, naming the task and the path", () => {
    const repo = fixtureRepo();
    withGitmodules(repo, ["vendor/lib"]);
    const rel = planWithScope(repo, "vendor/lib/**");

    // approve refuses too — it runs the same validation, so a plan that cannot
    // execute is never given a token a later create would honor
    const approve = cli(repo, "graph", "approve", "--graph", rel);
    expect(approve.status).not.toBe(0);
    expect(approve.stderr).toContain("vendor/lib");

    const r = cli(repo, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("vendor/lib");
    expect(r.stderr).toContain('task "a"');
    expect(goalIds(repo)).toEqual([]);
  });

  test("a scopeless task in a submodule repository refuses", () => {
    const repo = fixtureRepo();
    withGitmodules(repo, ["vendor/lib"]);
    const rel = planWithScope(repo, null);
    const r = cli(repo, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no scope");
    expect(goalIds(repo)).toEqual([]);
  });

  test("the dry run reports the same refusal a real create would", () => {
    const repo = fixtureRepo();
    withGitmodules(repo, ["vendor/lib"]);
    const rel = planWithScope(repo, "vendor/lib/**");
    const dry = cli(repo, "graph", "create", "--graph", rel, "--dry-run");
    expect(dry.status).not.toBe(0);
    expect(dry.stderr).toContain("vendor/lib");
  });
});
