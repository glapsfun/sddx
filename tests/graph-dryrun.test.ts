import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { GRAPH_HEADER, goalIds, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env: process.env });
}

const SPEC = (task: string, scope?: string) => `task: ${task}
success_criteria:
  - "it works"
${scope ? `scope:\n  - "${scope}"\n` : ""}oracle:
  type: command
  run: "true"
`;

/** A repo with a two-node graph (alpha → beta) under .sddx/drafts/. */
function planRepo(cwd: string): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, "a.yaml"), SPEC("build the alpha part", "src/alpha/**"));
  writeFileSync(join(drafts, "b.yaml"), SPEC("build the beta part", "src/beta/**"));
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(
    join(cwd, rel),
    `${GRAPH_HEADER}goal: ship the widget
tasks:
  - alias: alpha
    spec: a.yaml
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
  );
  return rel;
}

/** Every artifact a real create would produce. */
function sideEffects(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  const branches = spawnSync("git", ["branch", "--list", "sddx/*"], { cwd, encoding: "utf8" });
  const worktrees = spawnSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
  return {
    tasks: dir(join(".sddx", "tasks")),
    goals: goalIds(cwd),
    specs: dir(join(".sddx", "specs")),
    branches: (branches.stdout ?? "").trim(),
    worktreeCount: (worktrees.stdout ?? "").trim().split("\n").length,
  };
}

describe("graph create --dry-run", () => {
  test("writes nothing and exits 0", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = sideEffects(cwd);

    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).toBe(0);
    expect(sideEffects(cwd)).toEqual(before);
    expect(r.stdout).toContain("nothing written");
  });

  describe("renders the Goal Brief header", () => {
    /** The plan repo above, with a full brief header in place of the bare one. */
    function briefedRepo(cwd: string): string {
      const rel = planRepo(cwd);
      writeFileSync(
        join(cwd, rel),
        `${GRAPH_HEADER}goal: ship the widget
answers:
  - id: q1
    question: which store?
    answer: postgres
assumptions:
  - "the project uses Vite"
unresolved:
  - "whether to rotate secrets on deploy"
tasks:
  - alias: alpha
    spec: a.yaml
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
      );
      return rel;
    }

    test("shows what was answered, assumed, and left unresolved", () => {
      const { clone: cwd } = fixtureClone();
      const rel = briefedRepo(cwd);
      const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("which store?");
      expect(r.stdout).toContain("postgres");
      expect(r.stdout).toContain("the project uses Vite");
      expect(r.stdout).toContain("whether to rotate secrets on deploy");
    });

    test("carries the same brief in the JSON payload", () => {
      const { clone: cwd } = fixtureClone();
      const rel = briefedRepo(cwd);
      const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run", "--output", "json");
      expect(r.status).toBe(0);
      const brief = JSON.parse(r.stdout).data.brief;
      expect(brief.interactionMode).toBe("human");
      expect(brief.answers).toEqual([{ id: "q1", question: "which store?", answer: "postgres" }]);
      expect(brief.assumptions).toEqual(["the project uses Vite"]);
      expect(brief.unresolved).toEqual(["whether to rotate secrets on deploy"]);
    });

    test("omits the brief sections a header does not declare", () => {
      const { clone: cwd } = fixtureClone();
      const rel = planRepo(cwd); // header with no answers/assumptions/unresolved
      const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("answered:");
      expect(r.stdout).not.toContain("unresolved:");
    });
  });

  test("reports goal, node count, workspace mode, base sha, and validation verdict", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run", "--output", "json");
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout).data;
    expect(data.dryRun).toBe(true);
    expect(data.goal).toBe("ship the widget");
    expect(data.workspaceMode).toBe("worktree");
    expect(data.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(data.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.executionOrder).toEqual(["alpha", "beta"]);
    expect(data.nodes.beta.depends_on).toBe("alpha");
    expect(data.nodes.alpha.oracle).toContain("true");
    expect(data.nodes.alpha.scope).toBe("src/alpha/**");
  });

  test("render and real creation agree on workspace mode, base sha, and node set", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const dry = JSON.parse(
      cli(cwd, "graph", "create", "--graph", rel, "--dry-run", "--output", "json").stdout,
    ).data;

    cli(cwd, "graph", "approve", "--graph", rel);
    const real = JSON.parse(
      cli(cwd, "graph", "create", "--graph", rel, "--output", "json").stdout,
    ).data;

    expect(real.baseSha).toBe(dry.baseSha);
    expect(Object.keys(real.aliasToId).sort()).toEqual(dry.executionOrder.sort());
    expect(real.goalId).toBe(dry.goalId);
  });

  test("an invalid plan fails the dry run and is never presented for approval", () => {
    const cwd = fixtureRepo();
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    // no oracle → invalid
    writeFileSync(join(drafts, "a.yaml"), 'task: do a thing\nsuccess_criteria:\n  - "works"\n');
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(
      join(cwd, rel),
      `${GRAPH_HEADER}goal: g\ntasks:\n  - alias: alpha\n    spec: a.yaml\n`,
    );

    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("alpha");
    expect(sideEffects(cwd).tasks).toEqual([]);
  });

  test("a cycle fails the dry run naming the cycle", () => {
    const cwd = fixtureRepo();
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "a.yaml"), SPEC("alpha work"));
    writeFileSync(join(drafts, "b.yaml"), SPEC("beta work"));
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(
      join(cwd, rel),
      `${GRAPH_HEADER}goal: g
tasks:
  - alias: alpha
    spec: a.yaml
    depends_on: beta
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
    );
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.status).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("cycle");
  });
});

describe("re-render diffing", () => {
  test("a second render reports only what changed", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const first = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(first.stdout).toContain("execution order:");

    writeFileSync(
      join(cwd, ".sddx", "drafts", "b.yaml"),
      SPEC("build the beta part", "src/beta-revised/**"),
    );
    const second = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("changes since last render:");
    expect(second.stdout).toContain("~ beta");
    expect(second.stdout).toContain("src/beta-revised/**");
    // the unchanged node is not reprinted in full
    expect(second.stdout).not.toContain("~ alpha");
  });

  test("an unchanged re-render says so", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    const second = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(second.stdout).toContain("changes since last render: none");
  });

  test("a re-render still shows the plan, not just the diff", () => {
    // The approval dialog tells the human to review with `--dry-run`, but the
    // cache is primed by ANY dry run — including the agent's own ungated review
    // render. With the listing behind `else`, the human's read printed a hash
    // and "changes since last render: none" describing nothing at all.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    const second = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(second.stdout).toContain("execution order:");
    expect(second.stdout).toContain("alpha: build the alpha part");
    expect(second.stdout).toContain("beta: build the beta part");
    expect(second.stdout).toContain("oracle:");
    expect(second.stdout).toContain("changes since last render: none");
  });

  test("the first render of a plan shows it in full", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const r = cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(r.stdout).toContain("alpha: build the alpha part");
    expect(r.stdout).toContain("beta: build the beta part");
    expect(r.stdout).not.toContain("changes since last render");
  });
});

describe("re-render diff covers every approval-relevant field", () => {
  /** Rewrites node n1's spec wholesale and returns the second render. */
  function reRenderAfter(spec: string): string {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run"); // seed the cache
    writeFileSync(join(cwd, ".sddx", "drafts", "b.yaml"), spec);
    return cli(cwd, "graph", "create", "--graph", rel, "--dry-run").stdout;
  }

  const BASE = `task: build the beta part
success_criteria:
  - "one"
  - "two"
  - "three"
scope:
  - "src/beta/**"
oracle:
  type: command
  run: "true"
`;

  test('narrowed success_criteria are reported, not swallowed as "none"', () => {
    // The defect this guards: the diff covered only task/oracle/scope/depends_on,
    // so rewriting acceptance criteria rendered as "changes since last render:
    // none" and a human re-reviewing would approve them believing nothing moved.
    const out = reRenderAfter(BASE.replace('  - "two"\n  - "three"\n', ""));
    expect(out).toContain("~ beta");
    expect(out).toContain("success_criteria");
    expect(out).not.toContain("changes since last render: none");
  });

  test("added assumptions are reported", () => {
    const out = reRenderAfter(`${BASE}assumptions:\n  - "the project uses Vite"\n`);
    expect(out).toContain("~ beta");
    expect(out).toContain("assumptions");
  });

  test("changed stop_rules and out_of_scope are reported", () => {
    expect(reRenderAfter(`${BASE}stop_rules:\n  - max_iterations: 9\n`)).toContain("stop_rules");
    expect(reRenderAfter(`${BASE}out_of_scope:\n  - "auth"\n`)).toContain("out_of_scope");
  });

  test("an edited Goal Brief header is reported, not swallowed as none", () => {
    // The header is what the whole plan was built ON. The diff covered only the
    // node summaries, so revising a constraint, an acceptance criterion, or the
    // unresolved list rendered as "changes since last render: none" — to a human
    // told by the skill that a second read is cheap.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run"); // seed the cache
    const graph = readFileSync(join(cwd, rel), "utf8");
    writeFileSync(join(cwd, rel), `constraints:\n  - "no new dependencies"\n${graph}`);

    const out = cli(cwd, "graph", "create", "--graph", rel, "--dry-run").stdout;
    expect(out).toContain("~ goal brief");
    expect(out).toContain("constraints");
    expect(out).not.toContain("changes since last render: none");
  });

  test("a genuinely unchanged plan still reports none", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, "graph", "create", "--graph", rel, "--dry-run");
    expect(cli(cwd, "graph", "create", "--graph", rel, "--dry-run").stdout).toContain(
      "changes since last render: none",
    );
  });
});
