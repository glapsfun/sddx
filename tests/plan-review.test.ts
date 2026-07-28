import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone } from "./fixtures";
import { GRAPH_HEADER, goalIds, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env: process.env });

const SPEC = (task: string, scope: string) => `task: ${task}
success_criteria:
  - "it works"
scope:
  - "${scope}"
oracle:
  type: command
  run: "true"
`;

const BRIEF = `${GRAPH_HEADER}goal: ship the widget
answers:
  - id: q1
    question: which store?
    answer: postgres
assumptions:
  - "the project uses Vite"
constraints:
  - "no new runtime dependencies"
out_of_scope:
  - "password reset"
`;

/** A two-node plan (alpha → beta) with a full Goal Brief header. */
function planRepo(cwd: string): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, "a.yaml"), SPEC("build the alpha part", "src/alpha/**"));
  writeFileSync(join(drafts, "b.yaml"), SPEC("build the beta part", "src/beta/**"));
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(
    join(cwd, rel),
    `${BRIEF}tasks:
  - alias: alpha
    spec: a.yaml
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
  );
  return rel;
}

/** Everything the plan-review stage must not bring into existence. */
function runState(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)).sort() : []);
  const branches = spawnSync("git", ["branch", "--list"], { cwd, encoding: "utf8" });
  const worktrees = spawnSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
  return {
    goals: goalIds(cwd),
    tasks: dir(join(".sddx", "tasks")),
    receipts: dir(join(".sddx", "receipts")),
    approvals: dir(join(".sddx", "approvals")),
    branches: (branches.stdout ?? "").trim(),
    worktrees: (worktrees.stdout ?? "").trim().split("\n").length,
  };
}

const withMode = (cwd: string, mode: string) => {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    JSON.stringify({ interaction_mode: mode, auto_max_tasks: 9 }),
  );
};

describe("plan summary", () => {
  test("rendering creates no goal, branch, worktree, task, receipt, or token", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = runState(cwd);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).toBe(0);
    expect(runState(cwd)).toEqual(before);
  });

  test("names the target branch, the proposed run branch, and the worktree count", () => {
    const { clone: cwd } = fixtureClone();
    const r = cli(cwd, "graph", "create", "--graph", planRepo(cwd), "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("target branch: main");
    expect(r.stdout).toMatch(/run branch: sddx\/run-/);
    expect(r.stdout).toContain("worktrees:");
  });

  test("states the decisions the plan descended from", () => {
    const { clone: cwd } = fixtureClone();
    const r = cli(cwd, "graph", "create", "--graph", planRepo(cwd), "--dry-run");
    expect(r.stdout).toContain("which store?");
    expect(r.stdout).toContain("the project uses Vite");
    expect(r.stdout).toContain("no new runtime dependencies");
    expect(r.stdout).toContain("password reset");
  });

  test("shows every task's scope and oracle in dependency order", () => {
    const { clone: cwd } = fixtureClone();
    const r = cli(cwd, "graph", "create", "--graph", planRepo(cwd), "--dry-run");
    expect(r.stdout.indexOf("alpha")).toBeLessThan(r.stdout.indexOf("beta"));
    expect(r.stdout).toContain("src/alpha/**");
    expect(r.stdout).toContain("src/beta/**");
  });

  test("carries equivalent data in JSON", () => {
    const { clone: cwd } = fixtureClone();
    const r = cli(
      cwd,
      "graph",
      "create",
      "--graph",
      planRepo(cwd),
      "--dry-run",
      "--output",
      "json",
    );
    const d = JSON.parse(r.stdout).data;
    expect(d.targetBranch).toBe("main");
    expect(d.runBranch).toMatch(/^sddx\/run-/);
    expect(d.worktreeCount).toBe(1); // one root; beta is deferred until alpha is DONE
    expect(d.taskCount).toBe(2);
    expect(d.interactionMode).toBe("human");
    expect(d.brief.answers[0].answer).toBe("postgres");
  });

  test("renders in Markdown without losing the same facts", () => {
    const { clone: cwd } = fixtureClone();
    const r = cli(
      cwd,
      "graph",
      "create",
      "--graph",
      planRepo(cwd),
      "--dry-run",
      "--output",
      "markdown",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("target branch: main");
    expect(r.stdout).toContain("which store?");
  });

  test("a scope-overlap failure is reported and the plan is not offered for approval", () => {
    const { clone: cwd } = fixtureClone();
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    // two roots writing the same lane — illegal, since nothing orders them
    writeFileSync(join(drafts, "a.yaml"), SPEC("alpha work", "src/shared/**"));
    writeFileSync(join(drafts, "b.yaml"), SPEC("beta work", "src/shared/x.ts"));
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(
      join(cwd, rel),
      `${BRIEF}tasks:\n  - alias: alpha\n    spec: a.yaml\n  - alias: beta\n    spec: b.yaml\n`,
    );
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("scope overlap");
    // and no menu was printed alongside the failure
    expect(r.stdout).not.toContain("Approve");
  });

  test("an oracle-contract failure is reported the same way", () => {
    const { clone: cwd } = fixtureClone();
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "a.yaml"), 'task: no oracle here\nsuccess_criteria:\n  - "works"\n');
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(join(cwd, rel), `${BRIEF}tasks:\n  - alias: alpha\n    spec: a.yaml\n`);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("Approve");
  });
});

describe("the four plan actions", () => {
  test("exactly Approve, Edit, Regenerate and Cancel — no fifth", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "human");
    const r = cli(
      cwd,
      "graph",
      "create",
      "--graph",
      planRepo(cwd),
      "--dry-run",
      "--output",
      "json",
    );
    expect(JSON.parse(r.stdout).data.actions).toEqual(["Approve", "Edit", "Regenerate", "Cancel"]);
  });

  test("displaying the menu authorizes none of them", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "human");
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(runState(cwd).approvals).toEqual([]);
    // and a real create still refuses without a token
    expect(cli(cwd, "graph", "create", "--graph", rel).status).toBe(3);
  });

  test("auto mode renders no menu and waits for no selection", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "auto");
    const r = cli(
      cwd,
      "graph",
      "create",
      "--graph",
      planRepo(cwd),
      "--dry-run",
      "--output",
      "json",
    );
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout).data;
    expect(d.actions).toEqual([]);
    expect(d.interactionMode).toBe("auto");
  });

  test("auto mode's terminal render offers nothing to select", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "auto");
    const r = cli(cwd, "graph", "create", "--graph", planRepo(cwd), "--dry-run");
    expect(r.stdout).not.toContain("Approve");
    expect(r.stdout).not.toContain("Regenerate");
  });

  test("the plan menu is not the goal-scoped Next Actions menu", () => {
    // two different menus at two different points in the lifecycle; the plan
    // menu names no post-run action
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "human");
    const r = cli(cwd, "graph", "create", "--graph", planRepo(cwd), "--dry-run");
    for (const postRun of ["Open a PR", "pr create", "Merge", "cleanup"]) {
      expect(r.stdout).not.toContain(postRun);
    }
  });
});

describe("graph regenerate", () => {
  test("truncates the draft to its header and drops the node specs", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = readFileSync(join(cwd, rel), "utf8");
    const r = cli(cwd, "graph", "regenerate", "--graph", rel);
    expect(r.status).toBe(0);

    const after = readFileSync(join(cwd, rel), "utf8");
    expect(after).toBe(BRIEF);
    // every recorded answer survives, byte for byte
    expect(before.startsWith(after)).toBe(true);
    expect(after).toContain("answer: postgres");
    expect(after).not.toContain("alias: alpha");
    expect(existsSync(join(cwd, ".sddx", "drafts", "a.yaml"))).toBe(false);
  });

  test("leaves no run state and no token behind", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = runState(cwd);
    cli(cwd, "graph", "regenerate", "--graph", rel);
    expect(runState(cwd)).toEqual(before);
  });

  test("refuses once the plan has been materialized", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, "graph", "create", "--graph", rel).status).toBe(0);
    const r = cli(cwd, "graph", "regenerate", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already");
  });
});

describe("graph cancel", () => {
  test("removes the drafts and nothing else", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = runState(cwd);
    const r = cli(cwd, "graph", "cancel", "--graph", rel);
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, rel))).toBe(false);
    expect(existsSync(join(cwd, ".sddx", "drafts", "a.yaml"))).toBe(false);
    expect(existsSync(join(cwd, ".sddx", "drafts", "b.yaml"))).toBe(false);
    expect(runState(cwd)).toEqual(before);
  });

  test("refuses once the plan has been materialized", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, "graph", "create", "--graph", rel).status).toBe(0);
    const r = cli(cwd, "graph", "cancel", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cwd, rel))).toBe(true);
  });

  test("discards the cached render, so a re-plan does not diff against it", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run"); // seeds the cache
    expect(cli(cwd, "graph", "cancel", "--graph", rel).status).toBe(0);
    // the goal id comes from the goal SENTENCE, so re-planning it lands on the
    // same cache key — a stale entry would describe a plan the user cancelled
    planRepo(cwd);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.stdout).not.toContain("changes since last render");
  });
});

// Both actions delete (and Regenerate rewrites), and the paths they act on come
// from a command line the agent composes plus `spec:` strings a draft declares.
// The Bash gate lets the sddx CLI run in every phase, so without containment an
// executor blocked from writing source could still delete it through this.
describe("Regenerate and Cancel act only inside .sddx/drafts/", () => {
  test("refuses a --graph outside the drafts directory, deleting nothing", () => {
    const { clone: cwd } = fixtureClone();
    const victim = join(cwd, "src", "index.ts");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(victim, "export const x = 1\n");
    for (const action of ["cancel", "regenerate"]) {
      const r = cli(cwd, "graph", action, "--graph", join("src", "index.ts"));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("drafts");
      expect(readFileSync(victim, "utf8")).toBe("export const x = 1\n");
    }
  });

  test("refuses a node spec path that escapes the drafts directory", () => {
    const { clone: cwd } = fixtureClone();
    const victim = join(cwd, "src", "index.ts");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(victim, "export const x = 1\n");
    const rel = planRepo(cwd);
    writeFileSync(
      join(cwd, rel),
      `${BRIEF}tasks:
  - alias: alpha
    spec: ../../src/index.ts
`,
    );
    const r = cli(cwd, "graph", "cancel", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(cwd, rel))).toBe(true);
  });

  test("a goal record that exists but cannot be parsed still counts as materialized", () => {
    // Reading every `readGoal` failure as "still a draft" let Cancel delete the
    // plan artifacts of a live run — the ones its approval token and recorded
    // plan_sha256 are bound to.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, "graph", "create", "--graph", rel).status).toBe(0);

    const gid = goalIds(cwd)[0]!;
    // a record written by an incompatible version: present, but unreadable
    spawnSync("git", ["update-ref", "-d", `refs/sddx/goals/${gid}`], { cwd });
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "goals", `${gid}.json`), '{"id":"x"}');

    const r = cli(cwd, "graph", "cancel", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cwd, rel))).toBe(true);
  });
});

describe("Edit", () => {
  test("an edited answer changes the plan hash, so the prior approval no longer matches", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);

    const edited = readFileSync(join(cwd, rel), "utf8").replace("postgres", "sqlite");
    writeFileSync(join(cwd, rel), edited);

    // the approval was over the plan the user actually read
    const r = cli(cwd, "graph", "create", "--graph", rel);
    expect(r.status).toBe(3);
    expect(runState(cwd).goals).toEqual([]);
  });
});

describe("the two menus are distinct and each shown once", () => {
  function completed(cwd: string) {
    const rel = planRepo(cwd);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
    const created = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    return { rel, goalId: JSON.parse(created.stdout).data.goalId as string, created };
  }

  test("a real create prints no plan menu — the menu belongs to the dry run", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "human");
    const { created } = completed(cwd);
    expect(created.stdout).not.toContain("Regenerate");
  });

  test("the goal-scoped Next Actions menu offers none of the four plan actions", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "human");
    const { goalId } = completed(cwd);
    const r = cli(cwd, "next-actions", "--goal", goalId);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Regenerate");
    expect(r.stdout).not.toContain("graph approve");
  });

  test("an auto run is authorized with no human approval token on disk", () => {
    const { clone: cwd } = fixtureClone();
    withMode(cwd, "auto");
    const rel = planRepo(cwd);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(r.status).toBe(0);
    // nothing human-approved it: the authorization is the mode itself
    expect(runState(cwd).approvals).toEqual([]);
    expect(r.stdout).not.toContain("Approve");
  });
});
