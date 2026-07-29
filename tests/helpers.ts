import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskId } from "../src/lib/task";

export const repoRoot = new URL("..", import.meta.url).pathname;

/** The Goal Brief header keys every *planned* graph must carry. Intake writes
 * the header; the orchestrator appends `tasks:`. Fixtures that hand-write a
 * plan prepend this so they describe a plan rather than a half-written draft.
 * The optional list keys (answers, assumptions, …) are omitted on purpose —
 * this is the minimum a graph needs to parse. */
export const GRAPH_HEADER_LINES = ['schema_version: "1.0"', "interaction_mode: human"];
export const GRAPH_HEADER = `${GRAPH_HEADER_LINES.join("\n")}\n`;

/** The task id sddx will derive from a spec's `task:` sentence — the stable key
 * that lets `createRun` match created ids back to aliases without relying on
 * the order `graph create` happens to emit them in. */
function specTaskId(spec: string): string {
  const sentence = /^task:\s*(.+)$/m.exec(spec)?.[1]?.trim();
  if (!sentence) throw new Error(`createRun: spec has no \`task:\` line:\n${spec}`);
  return taskId(sentence);
}

export interface RunNode {
  alias: string;
  /** Full spec YAML for this node. */
  spec: string;
  dependsOn?: string[];
}

export interface CreatedRun {
  /** alias → task id, in graph order. */
  ids: Record<string, string>;
  /** Task ids in graph order — the common case is `taskIds[0]` for a one-node run. */
  taskIds: string[];
  goalId: string;
  runBranch: string;
}

/**
 * Create a canonical run: writes the specs and a graph, approves the plan, and
 * runs `graph create`. This is the ONLY creation surface — `task create` and
 * `goal create` were removed, so every test that just needs "a task to exist"
 * goes through here. A single task is a one-node run, not a special case.
 *
 * `cli` is the caller's own spawn wrapper so each test file keeps its env and
 * interaction-mode setup; it must return the spawn result.
 */
export function createRun(
  cwd: string,
  cli: (
    cwd: string,
    ...args: string[]
  ) => { status: number | null; stdout: string; stderr: string },
  goal: string,
  nodes: RunNode[],
  opts: { graphName?: string; approve?: boolean } = {},
): CreatedRun {
  const rel = opts.graphName ?? "graph.yaml";
  mkdirSync(join(cwd, "specs"), { recursive: true });
  const lines = [...GRAPH_HEADER_LINES, `goal: ${goal}`, "tasks:"];
  for (const n of nodes) {
    writeFileSync(join(cwd, "specs", `${n.alias}.yaml`), n.spec);
    lines.push(`  - alias: ${n.alias}`, `    spec: specs/${n.alias}.yaml`);
    if (n.dependsOn && n.dependsOn.length > 0) {
      lines.push(`    depends_on: [${n.dependsOn.join(", ")}]`);
    }
  }
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);

  if (opts.approve !== false) {
    const a = cli(cwd, "graph", "approve", "--graph", rel);
    if (a.status !== 0) throw new Error(`graph approve failed: ${a.stderr || a.stdout}`);
  }
  const c = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
  if (c.status !== 0) throw new Error(`graph create failed: ${c.stderr || c.stdout}`);
  const data = JSON.parse(c.stdout).data as {
    taskIds: string[];
    goalId: string;
    runBranch: string;
  };
  // Map by DERIVED ID, never by position: `graph create` emits ids in
  // topological order (roots first), which is not the caller's declaration
  // order whenever a dependent is listed before its parent. Zipping the two
  // lists positionally silently swapped the aliases in exactly that case, so a
  // test asserting on `ids.child` would have been reading the root's task.
  const ids: Record<string, string> = {};
  for (const n of nodes) {
    const expected = specTaskId(n.spec);
    const match = data.taskIds.find((id) => id === expected);
    if (!match) {
      throw new Error(
        `createRun: no created task id matched alias "${n.alias}" (derived "${expected}") in [${data.taskIds.join(", ")}]`,
      );
    }
    ids[n.alias] = match;
  }
  return { ids, taskIds: data.taskIds, goalId: data.goalId, runBranch: data.runBranch };
}

/** A minimal always-passing spec, the shape most scaffolding tests want. */
export const passingSpec = (task: string, scope?: string): string =>
  `task: ${task}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n${
    scope ? `scope:\n  - ${scope}\n` : ""
  }`;

/** Inject oracle_red evidence dated 1970 — satisfies verify's red-check gate in
 * fixtures whose oracles pass from the start. Real red-checks are e2e-tested. */
export function fakeRedCheck(root: string, id: string): void {
  const path = taskStatePath(root, id);
  const t = JSON.parse(readFileSync(path, "utf8"));
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
}

/** Where a task's state file actually lives. A canonical run puts root tasks in
 * their own worktree, so the main checkout's `.sddx/tasks/` holds only deferred
 * dependents — checking the worktree first is what makes this work for both. */
export function taskStatePath(root: string, id: string): string {
  const inWorktree = join(root, ".sddx-worktrees", id, ".sddx", "tasks", `${id}.json`);
  return existsSync(inWorktree) ? inWorktree : join(root, ".sddx", "tasks", `${id}.json`);
}

export async function runsCleanly(cmd: string[], env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await new Response(proc.stderr).text()).toBe("");
}

/**
 * Goal ids visible to sddx, wherever their records live.
 *
 * A canonical run commits its goal record to `sddx/run-<goal-id>`, so counting
 * files in the main checkout's `.sddx/goals/` no longer answers "did a goal get
 * created". Legacy loose records are still counted, since they are still read.
 */
export function goalIds(cwd: string): string[] {
  const ids = new Set<string>();
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  for (const r of (refs.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (r.startsWith("refs/sddx/goals/")) ids.add(r.slice("refs/sddx/goals/".length));
  }
  return [...ids].sort();
}

/** A goal record, read from wherever it lives. */
export function readGoalAnywhere(cwd: string, id: string): Record<string, unknown> {
  const r = spawnSync("git", ["cat-file", "-p", `refs/sddx/goals/${id}`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status === 0) return JSON.parse(r.stdout);
  const loose = join(cwd, ".sddx", "goals", `${id}.json`);
  if (existsSync(loose)) return JSON.parse(readFileSync(loose, "utf8"));
  throw new Error(`no goal ${id} in ${cwd}: ${r.stderr}`);
}

/** Rewrites a goal record wherever it lives — for tests that tamper with it. */
export function mutateGoal(cwd: string, mutate: (g: Record<string, unknown>) => void): void {
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  const ids = (refs.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((r) => r.startsWith("refs/sddx/goals/"))
    .map((r) => r.slice("refs/sddx/goals/".length));
  for (const id of ids) {
    const g = readGoalAnywhere(cwd, id);
    mutate(g);
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd,
      input: `${JSON.stringify(g, null, 2)}\n`,
      encoding: "utf8",
    });
    spawnSync("git", ["update-ref", `refs/sddx/goals/${id}`, (blob.stdout ?? "").trim()], { cwd });
  }
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const p = join(dir, f);
      const g = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      mutate(g);
      writeFileSync(p, `${JSON.stringify(g, null, 2)}\n`);
    }
  }
}
