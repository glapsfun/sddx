import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalPath, planHash } from "../src/lib/approval";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { goalIds, readGoalAnywhere, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env });
}
// Mode is config-only by design (config.ts executionMode): the environment is
// part of the command line the agent composes, so it must not switch the gate.
const human = process.env;
const auto = process.env;
function withMode(cwd: string, mode: "human" | "auto"): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify({ execution_mode: mode }));
}

const SPEC = (task: string, scope?: string) => `task: ${task}
success_criteria:
  - "it works"
${scope ? `scope:\n  - "${scope}"\n` : ""}oracle:
  type: command
  run: "true"
`;

function planRepo(cwd: string, nodes = 2): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = ["goal: ship the widget", "tasks:"];
  for (let i = 0; i < nodes; i++) {
    const alias = `n${i}`;
    writeFileSync(join(drafts, `${alias}.yaml`), SPEC(`build part ${i}`, `src/${alias}/**`));
    lines.push(`  - alias: ${alias}`, `    spec: ${alias}.yaml`);
  }
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

function created(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  const branches = spawnSync("git", ["branch", "--list", "sddx/*"], { cwd, encoding: "utf8" });
  return {
    tasks: dir(join(".sddx", "tasks")),
    goals: goalIds(cwd),
    specs: dir(join(".sddx", "specs")),
    branches: (branches.stdout ?? "").trim(),
  };
}

describe("approval predicate on graph create", () => {
  test("human mode with no token exits 3 and writes nothing", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const before = created(cwd);

    const r = cli(cwd, human, "graph", "create", "--graph", rel);
    expect(r.status).toBe(3);
    expect(created(cwd)).toEqual(before);
    expect(r.stderr).toContain("graph approve");
  });

  test("exit 3 is distinct from 1 (failure) and 2 (usage)", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);

    // 2 — usage: no --graph
    expect(cli(cwd, human, "graph", "create").status).toBe(2);
    // 1 — validation failure (invalid plan), which must NOT be reported as 3
    const bad = fixtureRepo();
    mkdirSync(join(bad, ".sddx", "drafts"), { recursive: true });
    writeFileSync(join(bad, ".sddx", "drafts", "a.yaml"), 'task: t\nsuccess_criteria:\n  - "w"\n');
    writeFileSync(
      join(bad, ".sddx", "drafts", "graph.yaml"),
      "goal: g\ntasks:\n  - alias: alpha\n    spec: a.yaml\n",
    );
    expect(
      cli(bad, human, "graph", "create", "--graph", join(".sddx", "drafts", "graph.yaml")).status,
    ).toBe(1);
    // 3 — approval required
    expect(cli(cwd, human, "graph", "create", "--graph", rel).status).toBe(3);
  });

  test("a valid token lets creation proceed", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);

    const r = cli(cwd, human, "graph", "create", "--graph", rel);
    expect(r.status).toBe(0);
    expect(created(cwd).goals).toHaveLength(1);
    // root tasks in worktree mode keep their state in their own worktrees, so
    // the run branch is what the main checkout observes
    expect(created(cwd).branches).toContain("sddx/run-");
  });

  test("editing a spec after approval blocks creation with a hash mismatch", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, human, "graph", "approve", "--graph", rel);

    // keep the scope — dropping it would make the plan overlap-invalid and it
    // would exit 1 on validation before ever reaching the gate
    writeFileSync(
      join(cwd, ".sddx", "drafts", "n1.yaml"),
      SPEC("build part 1, revised", "src/n1/**"),
    );
    const before = created(cwd);
    const r = cli(cwd, human, "graph", "create", "--graph", rel);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no approval");
    expect(created(cwd)).toEqual(before);
  });

  test("the predicate holds with no hook involved", () => {
    // the CLI is invoked directly here — no harness, no PreToolUse — so this
    // covers the defence-in-depth half of the gate on its own
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, human, "graph", "create", "--graph", rel).status).toBe(3);
  });

  test("validation failures are reported before approval is ever requested", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "drafts"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), 'task: t\nsuccess_criteria:\n  - "w"\n');
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(join(cwd, rel), "goal: g\ntasks:\n  - alias: alpha\n    spec: a.yaml\n");

    const r = cli(cwd, human, "graph", "create", "--graph", rel);
    // exits on validation (1), not on approval (3) — the human is never asked
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle");
    expect(r.stderr).not.toContain("graph approve");
  });

  test("auto mode within bounds needs no token", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    withMode(cwd, "auto");
    const r = cli(cwd, auto, "graph", "create", "--graph", rel);
    expect(r.status).toBe(0);
    expect(created(cwd).goals).toHaveLength(1);
  });
});

describe("sddx graph approve", () => {
  test("reports the approved hash and the token path", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    const { hash } = planHash(join(cwd, rel));

    const r = cli(cwd, human, "graph", "approve", "--graph", rel, "--output", "json");
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout).data;
    expect(data.planSha256).toBe(hash);
    expect(data.tokenPath).toContain(`${hash}.json`);
    expect(existsSync(approvalPath(cwd, hash))).toBe(true);
  });

  test("refuses an invalid plan and writes no token", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "drafts"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), SPEC("alpha work"));
    writeFileSync(join(cwd, ".sddx", "drafts", "b.yaml"), SPEC("beta work"));
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(
      join(cwd, rel),
      `goal: g
tasks:
  - alias: alpha
    spec: a.yaml
    depends_on: beta
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
    );
    const r = cli(cwd, human, "graph", "approve", "--graph", rel);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);
  });

  test("records the mode it approved for", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    cli(cwd, human, "graph", "approve", "--graph", rel);
    const { hash } = planHash(join(cwd, rel));
    const token = JSON.parse(readFileSync(approvalPath(cwd, hash), "utf8"));
    expect(token.mode).toBe("human");
    expect(token.plan_sha256).toBe(hash);
    expect(token.amendments).toEqual([]);
    expect(typeof token.at).toBe("string");
  });

  test("approving is idempotent for an unchanged plan", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd);
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    expect(readdirSync(join(cwd, ".sddx", "approvals"))).toHaveLength(1);
  });

  test("appears in usage", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, human, "--help");
    expect(r.stdout).toContain("graph approve");
    expect(r.stdout).toContain("--dry-run");
  });
});
