import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, SELF_MODIFYING_GLOBS } from "../src/lib/approval";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { GRAPH_HEADER_LINES, goalIds, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
function cli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env });
}
// Interaction mode is config-only by design (see config.ts interactionMode): the
// environment is part of the command line the agent composes, so it must not be
// able to switch the gate. Tests therefore write config, exactly as a user does.
const auto = process.env;
const human = process.env;
function withMode(cwd: string, mode: "human" | "auto", autoMaxTasks?: number): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    JSON.stringify({
      interaction_mode: mode,
      ...(autoMaxTasks ? { auto_max_tasks: autoMaxTasks } : {}),
    }),
  );
}

const SPEC = (task: string, opts: { scope?: string; oracleType?: string } = {}) => `task: ${task}
success_criteria:
  - "it works"
${opts.scope ? `scope:\n  - "${opts.scope}"\n` : ""}oracle:
  type: ${opts.oracleType ?? "command"}
  run: "true"
`;

function planRepo(
  cwd: string,
  nodes: number,
  perNode: (i: number) => { scope?: string; oracleType?: string } = (i) => ({
    scope: `src/n${i}/**`,
  }),
): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = [...GRAPH_HEADER_LINES, "goal: ship the widget", "tasks:"];
  for (let i = 0; i < nodes; i++) {
    const alias = `n${i}`;
    writeFileSync(join(drafts, `${alias}.yaml`), SPEC(`build part ${i}`, perNode(i)));
    lines.push(`  - alias: ${alias}`, `    spec: ${alias}.yaml`);
  }
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

function created(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  const branches = spawnSync("git", ["branch", "--list", "sddx/*"], { cwd, encoding: "utf8" });
  return { goals: goalIds(cwd), branches: (branches.stdout ?? "").trim() };
}

describe("auto mode refuses a manual oracle", () => {
  test("hard refusal at dry-run time, before any approval is requested", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2, (i) =>
      i === 1 ? { scope: "src/n1/**", oracleType: "manual" } : { scope: "src/n0/**" },
    );
    withMode(cwd, "auto");
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("n1");
    expect(r.stderr).toContain("manual");
    expect(created(cwd).goals).toEqual([]);
  });

  test("refusal is not an approval prompt — it names incoherence, not a missing token", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: "src/n0/**", oracleType: "manual" }));
    withMode(cwd, "auto");
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.stderr).not.toContain("graph approve");
  });

  test("a browser oracle is still permitted under auto", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: "src/n0/**", oracleType: "browser" }));
    withMode(cwd, "auto");
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.status).toBe(0);
    expect(created(cwd).goals).toHaveLength(1);
  });

  test("human mode may still plan a manual oracle", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: "src/n0/**", oracleType: "manual" }));
    withMode(cwd, "human");
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, human, "graph", "create", "--graph", rel).status).toBe(0);
  });
});

describe("auto mode never widens the TDD gate", () => {
  function taskInRepo(cwd: string): string {
    const spec = join(cwd, "spec.yaml");
    writeFileSync(spec, SPEC("do the widget work"));
    const r = cli(cwd, human, "task", "create", "--spec", "spec.yaml", "--workspace", "none");
    expect(r.status).toBe(0);
    return readdirSync(join(cwd, ".sddx", "tasks"))[0].replace(/\.json$/, "");
  }

  test("task allow is refused under auto mode with no entry written", () => {
    const cwd = fixtureRepo();
    const id = taskInRepo(cwd);
    withMode(cwd, "auto");
    const r = cli(cwd, auto, "task", "allow", id, "src/migration.sql");
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("human");
    const task = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8"));
    expect(task.allow ?? []).toEqual([]);
  });

  test("task allow is refused from inside a worktree, where config.json is absent", () => {
    // `task allow` is run BY the executor, from its own worktree — and
    // `.sddx/config.json` is not committed, so a worktree forked from
    // origin/HEAD has no copy. Reading the mode from the process cwd returned
    // `{}` there, which resolves to `human`, silently granting the one escape
    // hatch from the TDD gate on exactly the unattended runs it exists to stop.
    const { clone: cwd } = fixtureClone();
    const spec = join(cwd, "spec.yaml");
    writeFileSync(spec, SPEC("do the widget work"));
    withMode(cwd, "auto");
    const created = cli(
      cwd,
      auto,
      "task",
      "create",
      "--spec",
      "spec.yaml",
      "--workspace",
      "worktree",
    );
    expect(created.status).toBe(0);
    const id = readdirSync(join(cwd, ".sddx-worktrees"))[0] as string;
    const wt = join(cwd, ".sddx-worktrees", id);
    expect(existsSync(join(wt, ".sddx", "config.json"))).toBe(false);

    const r = cli(wt, auto, "task", "allow", id, "src/migration.sql");
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("human");
    const task = JSON.parse(readFileSync(join(wt, ".sddx", "tasks", `${id}.json`), "utf8"));
    expect(task.allow ?? []).toEqual([]);
  });

  test("task allow still succeeds under human mode and is recorded", () => {
    const cwd = fixtureRepo();
    const id = taskInRepo(cwd);
    withMode(cwd, "human");
    const r = cli(cwd, human, "task", "allow", id, "src/migration.sql");
    expect(r.status).toBe(0);
    const task = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8"));
    expect(task.allow).toContain("src/migration.sql");
  });
});

describe("auto mode blast radius", () => {
  test("a plan over auto_max_tasks is refused, not armed", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "auto", 3);
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    // exit 3 means "approval required"; a bound refuses instead, so not 3
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("auto_max_tasks");
    expect(created(cwd).goals).toEqual([]);
  });

  test("within the ceiling it proceeds unattended", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "auto", 3);
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.status).toBe(0);
  });

  test("a self-modifying scope is refused regardless of node count", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: "hooks/**" }));
    withMode(cwd, "auto", 99);
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("n0");
    expect(created(cwd).goals).toEqual([]);
  });

  test("auto cannot approve its way past a bound", () => {
    // Previously a token let an over-ceiling plan run unattended, recording the
    // degradation on the token. Approving is a human act, so it belongs to
    // human mode — reached by editing reviewed configuration, not by a token.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "auto", 3);
    expect(cli(cwd, auto, "graph", "approve", "--graph", rel).status).not.toBe(0);
    expect(cli(cwd, auto, "graph", "create", "--graph", rel).status).not.toBe(0);
    expect(created(cwd).goals).toEqual([]);
  });

  test("the same plan runs once configuration selects human mode", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "human", 3);
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, human, "graph", "create", "--graph", rel).status).toBe(0);
  });
});

describe("decideGate refuses rather than degrading", () => {
  const nodes = (n: number, scope = (i: number) => [`src/n${i}/**`]) =>
    Array.from({ length: n }, (_, i) => ({
      alias: `n${i}`,
      scope: scope(i),
      oracleType: "command",
    }));

  function graphOn(cwd: string, n: number): string {
    return join(cwd, planRepo(cwd, n));
  }

  test("names the requested mode and the triggering bound", () => {
    const cwd = fixtureRepo();
    const g = graphOn(cwd, 4);
    const d = decideGate(cwd, g, nodes(4), "auto", 3, scopesOverlap);
    expect(d.ok).toBe(false);
    expect(d.requestedMode).toBe("auto");
    // the mode is not rewritten to "human" — nothing degraded
    expect(d.mode).toBe("auto");
    expect(d.refusal).toContain("auto_max_tasks");
    expect(d.nodeCount).toBe(4);
  });

  /** Adds an `unresolved:` list to an already-written graph draft. */
  function withUnresolved(graphPath: string, ...items: string[]): string {
    const text = readFileSync(graphPath, "utf8");
    const block = ["unresolved:", ...items.map((i) => `  - "${i}"`), ""].join("\n");
    writeFileSync(graphPath, text.replace("tasks:", `${block}tasks:`));
    return graphPath;
  }

  test("a non-empty unresolved list refuses an auto plan that clears every path bound", () => {
    // The additive half of the blocker rule: intake reporting a decision it
    // could not safely take. It is layered ON TOP of the deterministic bounds,
    // never instead of them — see the next test.
    const cwd = fixtureRepo();
    const g = withUnresolved(graphOn(cwd, 2), "should signup collect date of birth?");
    const d = decideGate(cwd, g, nodes(2), "auto", 99, scopesOverlap);
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("should signup collect date of birth?");
  });

  test("the same unresolved plan is untouched in human mode, where a human already reviews it", () => {
    const cwd = fixtureRepo();
    const g = withUnresolved(graphOn(cwd, 2), "should signup collect date of birth?");
    const d = decideGate(cwd, g, nodes(2), "human", 99, scopesOverlap);
    expect(d.refusal).toBeUndefined();
  });

  test("a protected-path plan refuses even when intake reports nothing unresolved", () => {
    // The point of the deterministic bounds: they do not consult the
    // self-report, so a model that assumes its way past an auth decision and
    // writes an empty `unresolved` still cannot run unattended.
    const cwd = fixtureRepo();
    const g = graphOn(cwd, 2);
    expect(readFileSync(g, "utf8")).not.toContain("unresolved");
    const d = decideGate(
      cwd,
      g,
      nodes(2, (i) => (i === 1 ? ["src/auth/**"] : ["src/n0/**"])),
      "auto",
      99,
      scopesOverlap,
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("auth");
  });

  test("self-modification is reported with the offending node and paths", () => {
    const cwd = fixtureRepo();
    const g = graphOn(cwd, 2);
    const d = decideGate(
      cwd,
      g,
      nodes(2, (i) => (i === 1 ? [".github/workflows/**"] : ["src/n0/**"])),
      "auto",
      99,
      scopesOverlap,
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("n1");
    for (const glob of SELF_MODIFYING_GLOBS) expect(d.refusal).toContain(glob);
  });

  test("self-modification outranks the ceiling when both apply", () => {
    const cwd = fixtureRepo();
    const g = graphOn(cwd, 4);
    const d = decideGate(
      cwd,
      g,
      nodes(4, (i) => (i === 0 ? ["hooks/**"] : [`src/n${i}/**`])),
      "auto",
      1,
      scopesOverlap,
    );
    expect(d.refusal).toContain("enforcement paths");
  });

  test("an UNSCOPED node is refused — empty scope is unconfined", () => {
    // An empty scope means the task may write anywhere, which includes hooks/,
    // .claude-plugin/, and every protected path. Treating "no scope" as "no
    // reach" penalized honest scope declarations and made omitting `scope` a bypass.
    const cwd = fixtureRepo();
    const g = graphOn(cwd, 1);
    const d = decideGate(
      cwd,
      g,
      [{ alias: "n0", scope: [], oracleType: "command" }],
      "auto",
      6,
      scopesOverlap,
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("unconfined");
  });

  test("an unhashable plan is never approved", () => {
    const cwd = fixtureRepo();
    const d = decideGate(cwd, join(cwd, "missing.yaml"), nodes(1), "auto", 6, scopesOverlap);
    expect(d.ok).toBe(false);
    expect(d.hash).toBe("");
  });
});
