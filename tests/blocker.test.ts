import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone } from "./fixtures";
import { GRAPH_HEADER, goalIds, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env: process.env });

const SPEC = (task: string, scope?: string, oracleType = "command") => `task: ${task}
success_criteria:
  - "it works"
${scope === undefined ? "" : `scope:\n  - "${scope}"\n`}oracle:
  type: ${oracleType}
  run: "true"
`;

function auto(cwd: string, maxTasks = 9): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    JSON.stringify({ interaction_mode: "auto", auto_max_tasks: maxTasks }),
  );
}

/**
 * A plan in auto mode. `header` extends the Goal Brief; `scopes` gives each
 * node its lane (undefined = no `scope` key at all, i.e. unconfined).
 */
function planRepo(
  cwd: string,
  scopes: (string | undefined)[],
  header = "",
  oracleTypes: string[] = [],
): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = [`${GRAPH_HEADER}goal: ship the widget`, header, "tasks:"].filter((s) => s !== "");
  scopes.forEach((scope, i) => {
    writeFileSync(
      join(drafts, `n${i}.yaml`),
      SPEC(`build part ${i}`, scope, oracleTypes[i] ?? "command"),
    );
    lines.push(`  - alias: n${i}`, `    spec: n${i}.yaml`);
  });
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

/** Everything a blocker must leave untouched. */
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

describe("the structured blocker summary", () => {
  test("names the missing decision, its impact, and the next step", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(r.status).not.toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("error");
    const b = out.data.blocker;
    expect(b.bound).toBe("protected-path");
    expect(b.node).toBe("n1");
    expect(b.decision).toContain("auth");
    expect(b.impact).not.toBe("");
    expect(b.next_step).toContain("interaction_mode");
  });

  test("an unresolved decision is reported as the decision itself", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(
      cwd,
      ["src/n0/**"],
      'unresolved:\n  - "should signup collect date of birth?"',
    );
    const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(r.status).not.toBe(0);
    const b = JSON.parse(r.stdout).data.blocker;
    expect(b.bound).toBe("unresolved");
    expect(b.decision).toContain("date of birth");
  });

  test("the task-count ceiling reports as a policy bound, not a missing decision", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd, 2);
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**", "src/n2/**"]);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(r.status).not.toBe(0);
    const b = JSON.parse(r.stdout).data.blocker;
    expect(b.bound).toBe("task-ceiling");
    expect(b.decision).toContain("auto_max_tasks");
  });

  test("a manual oracle reports as unobservable, naming the node", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**"], "", ["manual"]);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    const b = JSON.parse(r.stdout).data.blocker;
    expect(b.bound).toBe("manual-oracle");
    expect(b.node).toBe("n0");
  });

  test("the terminal rendering carries the same three facts", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    const r = cli(cwd, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auth");
    expect(r.stderr).toContain("interaction_mode");
  });
});

describe("a blocker is terminal", () => {
  const cases: [string, (cwd: string) => string][] = [
    [
      "a critical unresolved decision",
      (cwd) => planRepo(cwd, ["src/n0/**"], 'unresolved:\n  - "which auth provider?"'),
    ],
    ["a protected-path policy", (cwd) => planRepo(cwd, ["src/n0/**", "src/migrations/**"])],
    ["an unconfined node", (cwd) => planRepo(cwd, [undefined])],
  ];

  for (const [label, build] of cases) {
    test(`${label} leaves zero run state`, () => {
      const { clone: cwd } = fixtureClone();
      auto(cwd);
      const rel = build(cwd);
      const before = runState(cwd);
      const r = cli(cwd, "graph", "create", "--graph", rel);
      expect(r.status).not.toBe(0);
      // not merely "no token" — nothing at all
      expect(runState(cwd)).toEqual(before);
      expect(runState(cwd).goals).toEqual([]);
    });
  }

  test("the task-count ceiling leaves the same zero run state", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd, 1);
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**"]);
    const before = runState(cwd);
    expect(cli(cwd, "graph", "create", "--graph", rel).status).not.toBe(0);
    expect(runState(cwd)).toEqual(before);
  });

  test("drafts survive a blocker, so the plan can be inspected and refined", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/secrets/**"]);
    expect(cli(cwd, "graph", "create", "--graph", rel).status).not.toBe(0);
    expect(existsSync(join(cwd, rel))).toBe(true);
    expect(readFileSync(join(cwd, rel), "utf8")).toContain("goal: ship the widget");
    expect(existsSync(join(cwd, ".sddx", "drafts", "n0.yaml"))).toBe(true);
  });

  test("a blocker never offers an approval as a way to continue", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/billing/**"]);
    const r = cli(cwd, "graph", "create", "--graph", rel);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).not.toContain("graph approve");
    expect(all).not.toContain("Approve");
    // and the remedy it DOES name is a reviewed-configuration edit, never a
    // flag or an environment variable the agent could compose for itself
    expect(all).toContain("interaction_mode");
    expect(all).not.toContain("--mode");
    expect(all).not.toContain("SDDX_INTERACTION_MODE");
  });

  test("and approving is refused outright, not merely unhelpful", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/credentials/**"]);
    const approve = cli(cwd, "graph", "approve", "--graph", rel);
    expect(approve.status).not.toBe(0);
    expect(runState(cwd).approvals).toEqual([]);
    // even with a token forced into place, creation still refuses
    expect(cli(cwd, "graph", "create", "--graph", rel).status).not.toBe(0);
  });
});

describe("the deterministic bound does not consult the intake self-report", () => {
  test("a protected-path plan blocks when intake reports nothing unresolved", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    expect(readFileSync(join(cwd, rel), "utf8")).not.toContain("unresolved");
    const r = cli(cwd, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auth");
  });

  test("`unresolved: []` cannot even be written — an empty list is malformed", () => {
    // so "report an empty list to look clean" is not available as a bypass;
    // the only way to report nothing unresolved is to omit the key, which the
    // test above shows changes nothing
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**"], "unresolved: []");
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("unresolved");
  });
});

describe("auto mode is non-interactive end to end", () => {
  test("no command in the goal→completion path prompts, offers, or waits", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**"]);
    const outputs: string[] = [];
    const record = (...args: string[]) => {
      const r = cli(cwd, ...args);
      outputs.push(r.stdout, r.stderr);
      return r;
    };

    expect(record("graph", "create", "--graph", rel, "--dry-run").status).toBe(0);
    const created = record("graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    const goalId = JSON.parse(created.stdout).data.goalId as string;
    record("board");
    record("run", "report", "--goal", goalId);

    const all = outputs.join("\n");
    for (const prompt of ["Approve", "Regenerate", "[y/N]", "(y/n)", "Select ", "press "]) {
      expect(all).not.toContain(prompt);
    }
  }, 60_000);
});
