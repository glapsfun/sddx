// A deferred dependent must not govern the human's own checkout.
//
// `resolveTask` step 3 ("sole non-terminal task in this workspace") filtered
// only on `isTerminal(phase)`. A deferred dependent — no worktree, phase PLAN,
// state written to the MAIN checkout because it has nowhere else to live — is
// non-terminal, so it claimed the checkout as its governing task. The
// characterizing run confirmed it exactly: one deferred dependent blocked every
// implementation write in the user's repository and named a task they never
// started; two made the checkout `ambiguous`.
//
// Today that needs `graph create` with edges, which is rare. Under the canonical
// run lifecycle every multi-node run has deferred nodes, so it would have been
// the default experience.
//
// Fixed by typing the state rather than filtering the symptom: `workspace.mode`
// gains `"deferred"`, and `materialize_as` records what it becomes. Previously
// `base_sha: "pending:<parent>"` did double duty as both a fork point and a
// lifecycle marker, which is what let a workspace-less task look like an active
// one. Legacy state carrying a `pending:` base under a real mode still reads as
// deferred.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTask } from "../src/lib/resolve";
import { tddGate } from "../src/tdd-gate";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

/** Approve then create, the two steps a user takes under the default human mode. */
function approveAndCreate(cwd: string, graph: string) {
  const approve = cli(cwd, "graph", "approve", "--graph", graph);
  if (approve.status !== 0) return approve;
  return cli(cwd, "graph", "create", "--graph", graph);
}

const spec = (task: string, scope: string) =>
  `task: ${task}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - ${scope}\n`;

/** One root plus `dependents` deferred children, all depending on the root. */
function chainGraph(cwd: string, dependents: number): void {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  writeFileSync(join(cwd, "specs", "a.yaml"), spec("parent task alpha", "src/db/**"));
  const lines = ["goal: ship the chain", "tasks:", "  - alias: a", "    spec: specs/a.yaml"];
  for (let i = 0; i < dependents; i++) {
    // each child's scope sits under the parent's, legal only because it is ordered after it
    writeFileSync(join(cwd, "specs", `c${i}.yaml`), spec(`child task ${i}`, `src/db/c${i}.ts`));
    lines.push(`  - alias: c${i}`, `    spec: specs/c${i}.yaml`, "    depends_on: a");
  }
  writeFileSync(join(cwd, "graph.yaml"), `${lines.join("\n")}\n`);
}

interface MainTask {
  id: string;
  phase: string;
  base: string;
  mode: string;
  materializeAs?: string;
}

/** Task states sitting in the MAIN checkout. */
function mainCheckoutTasks(cwd: string): MainTask[] {
  const dir = join(cwd, ".sddx", "tasks");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return {
        id: t.id,
        phase: t.phase,
        base: String(t.workspace?.base_sha ?? ""),
        mode: String(t.workspace?.mode ?? ""),
        materializeAs: t.workspace?.materialize_as,
      };
    });
}

/** The two task ids of a one-root/one-dependent chain, in graph order. */
function chainIds(cwd: string, created: { stdout: string }): [string, string] {
  const goalId = /created goal (\S+)/.exec(created.stdout)?.[1] as string;
  return JSON.parse(cli(cwd, "goal", "show", goalId).stdout).task_ids as [string, string];
}

describe("deferred dependents in the main checkout (D3)", () => {
  test("a deferred dependent is typed as deferred, recording what it will become", () => {
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    const deferred = mainCheckoutTasks(clone).filter((t) => t.mode === "deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.phase).toBe("PLAN");
    expect(deferred[0]?.materializeAs).toBe("worktree");
    // the pending base is still recorded — it names the parents, which is all it
    // was ever good for; it is no longer what marks the task as deferred
    expect(deferred[0]?.base).toStartWith("pending:");
  });

  test("ONE deferred dependent does not govern the main checkout", () => {
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    expect(resolveTask(clone).kind).toBe("none");
  });

  test("the human can edit implementation files in their own checkout", () => {
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    expect(tddGate({ filePath: join(clone, "src", "unrelated.ts") }).allow).toBe(true);
  });

  test("TWO deferred dependents do not make the checkout ambiguous", () => {
    const { clone } = fixtureClone();
    chainGraph(clone, 2);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    expect(resolveTask(clone).kind).toBe("none");
    expect(tddGate({ filePath: join(clone, "src", "unrelated.ts") }).allow).toBe(true);
  });

  test("test files and docs remain writable, as before", () => {
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    expect(tddGate({ filePath: join(clone, "tests", "unrelated.test.ts") }).allow).toBe(true);
    expect(tddGate({ filePath: join(clone, "README.md") }).allow).toBe(true);
  });

  test("legacy state — a pending base under a real mode — still reads as deferred", () => {
    // State written before `mode: "deferred"` existed carries mode "worktree"
    // with a `pending:` base. Reading it as active would reintroduce exactly the
    // block this change removes, on repositories mid-run during an upgrade.
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    expect(approveAndCreate(clone, "graph.yaml").status).toBe(0);

    const dir = join(clone, ".sddx", "tasks");
    const file = readdirSync(dir).find((f) => f.endsWith(".json")) as string;
    const t = JSON.parse(readFileSync(join(dir, file), "utf8"));
    t.workspace = { mode: "worktree", branch: null, base_sha: t.workspace.base_sha };
    writeFileSync(join(dir, file), JSON.stringify(t, null, 2));

    expect(resolveTask(clone).kind).toBe("none");
    expect(tddGate({ filePath: join(clone, "src", "unrelated.ts") }).allow).toBe(true);
  });
});

describe("a materialized dependent still gates its own worktree (1.3)", () => {
  test("once materialized it governs its worktree and blocks implementation in RED", () => {
    // The fix must not buy the main checkout back by disarming the gate for
    // dependents generally — a materialized dependent is an ordinary task.
    const { clone } = fixtureClone();
    chainGraph(clone, 1);
    const created = approveAndCreate(clone, "graph.yaml");
    expect(created.status).toBe(0);

    const [aId, bId] = chainIds(clone, created);

    // drive the parent to DONE inside its own worktree so the dependent can materialize
    const aWt = join(clone, ".sddx-worktrees", aId);
    cli(aWt, "task", "phase", aId, "RED", "--test-exit", "1");
    cli(aWt, "task", "phase", aId, "GREEN", "--test-exit", "0");
    cli(aWt, "task", "phase", aId, "VERIFY");
    fakeRedCheck(aWt, aId);
    expect(cli(aWt, "verify", aId).status).toBe(0);

    expect(cli(clone, "task", "materialize", bId).status).toBe(0);
    const bWt = join(clone, ".sddx-worktrees", bId);
    const t = JSON.parse(readFileSync(join(bWt, ".sddx", "tasks", `${bId}.json`), "utf8"));
    expect(t.workspace.mode).toBe("worktree");
    expect(String(t.workspace.base_sha)).not.toStartWith("pending:");

    // it is an ordinary task again: PLAN phase, so implementation is blocked here
    const d = tddGate({ filePath: join(bWt, "src", "db", "c0.ts") });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("child task");
  });
});
