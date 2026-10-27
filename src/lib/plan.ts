// Plans: a goal spec's tasks as a schedule, the checks it must pass before it
// may be approved or started, and the one function that turns an approved spec
// into a running goal. Everything `plan check` reports is computed here, so a
// check and a real start can never disagree about what the plan is.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  decideGate,
  type GateDecision,
  type GateNode,
  mergeAssumptions,
  planHash,
} from "./approval";
import { autoMaxTasks, ensureConfig, gateInteractionMode } from "./config";
import { branchExists, createBranchAt, forceDeleteBranch, git } from "./git";
import { scopesOverlap } from "./glob-overlap";
import { createGoal, deleteCreatedGoal, goalExists, goalIdFromSpec, runBranchName } from "./goal";
import { formatSpecError, type GoalSpec, parseGoalSpec } from "./goalspec";
import { createPlannedTask, resolveTaskState, taskPath } from "./task";
import {
  type BaseRef,
  resolveBaseRef,
  resolveMainRepoRoot,
  submoduleScopeConflicts,
  worktreeAvailable,
  worktreesDir,
} from "./worktree";

export const SPEC_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/;

export interface ScheduleNode {
  id: string;
  /** Predecessor ids, zero or more (fan-in allowed). */
  dependsOn: readonly string[];
  scope: readonly string[];
}

/** Reachability over every incoming edge; never includes `id` itself. `guard`
 * stops recursion through a cycle, which is rejected separately. */
function ancestors(
  id: string,
  parents: Map<string, readonly string[]>,
  guard: Set<string> = new Set([id]),
): Set<string> {
  const out = new Set<string>();
  for (const p of parents.get(id) ?? []) {
    if (guard.has(p)) continue;
    guard.add(p);
    out.add(p);
    for (const a of ancestors(p, parents, guard)) out.add(a);
  }
  return out;
}

/**
 * The schedule gate: no cycles, and every pair of tasks the DAG does not order
 * (including two co-parents of one fan-in child) has disjoint scope. A
 * dependency outside the node set is treated as already satisfied, not an error.
 */
export function validateSchedule(nodes: ScheduleNode[]): string[] {
  const errors: string[] = [];
  const parents = new Map<string, readonly string[]>();
  for (const n of nodes) parents.set(n.id, n.dependsOn);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) color.set(n.id, WHITE);
  const visit = (id: string): string | null => {
    color.set(id, GRAY);
    for (const p of parents.get(id) ?? []) {
      const c = color.get(p);
      if (c === GRAY) return p;
      if (c === WHITE) {
        const found = visit(p);
        if (found) return found;
      }
    }
    color.set(id, BLACK);
    return null;
  };
  for (const n of nodes) {
    if (color.get(n.id) !== WHITE) continue;
    const cyclic = visit(n.id);
    if (cyclic) errors.push(`dependency cycle involving "${cyclic}"`);
  }
  if (errors.length > 0) return [...new Set(errors)];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as ScheduleNode;
      const b = nodes[j] as ScheduleNode;
      const ordered = ancestors(a.id, parents).has(b.id) || ancestors(b.id, parents).has(a.id);
      if (!ordered && scopesOverlap(a.scope, b.scope)) {
        errors.push(
          `scope overlap between concurrent tasks "${a.id}" and "${b.id}"; order one after the other or make their scopes disjoint`,
        );
      }
    }
  }
  return [...new Set(errors)];
}

/** The plan rules that need only the spec, no repository. */
export function planRuleErrors(spec: GoalSpec): string[] {
  const errors: string[] = [];
  if (spec.tasks.length === 0) errors.push("plan has no tasks: add a `## Tasks` section");
  for (const d of spec.design.openDecisions) {
    errors.push(`open decision blocks planning: "${d}"`);
  }
  const ids = new Set(spec.tasks.map((t) => t.id));
  for (const t of spec.tasks) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) errors.push(`task ${t.id} depends on unknown task ${d}`);
    }
  }
  errors.push(
    ...validateSchedule(
      spec.tasks.map((t) => ({ id: t.id, dependsOn: t.depends_on, scope: t.scope })),
    ),
  );
  return errors;
}

/** Where an id is already in use, or null when it is free. */
export function taskIdInUse(root: string, id: string): string | null {
  const receipt = join(".sddx", "receipts", `${id}.json`);
  if (existsSync(join(root, receipt))) return receipt;
  if (existsSync(taskPath(root, id))) return relative(root, taskPath(root, id));
  if (existsSync(join(worktreesDir(root), id))) return join(".sddx-worktrees", id);
  if (branchExists(root, `sddx/${id}`)) return `branch sddx/${id}`;
  if (resolveTaskState(root, id)) return `task ${id}`;
  return null;
}

export interface ResolvedPlan {
  root: string;
  /** Repository-relative, POSIX separators. */
  specPath: string;
  absPath: string;
  spec?: GoalSpec;
  hash: string;
  goalId: string;
  runBranch: string;
  base?: BaseRef;
  notices: string[];
  errors: string[];
}

const posix = (p: string): string => p.split(sep).join("/");

/**
 * Tracked, and identical to HEAD in both the index and the working tree. An
 * uncommitted spec would collide with the plan commit on the run branch when
 * the run branch is merged back, and would leave the approved plan out of history.
 */
function isCommitted(root: string, specPath: string): boolean {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", specPath], { cwd: root });
  if (tracked.status !== 0) return false;
  return spawnSync("git", ["diff", "--quiet", "HEAD", "--", specPath], { cwd: root }).status === 0;
}

/**
 * Everything `plan check`, `plan approve` and `plan start` need to know before
 * they are entitled to write anything, computed once and identically for all
 * three.
 */
export function resolvePlan(cwd: string, specArg: string): ResolvedPlan {
  const root = resolveMainRepoRoot(cwd);
  const absPath = resolve(cwd, specArg);
  const specPath = posix(relative(root, absPath));
  const goalId = goalIdFromSpec(specPath);
  const plan: ResolvedPlan = {
    root,
    specPath,
    absPath,
    hash: "",
    goalId,
    runBranch: runBranchName(goalId),
    notices: [],
    errors: [],
  };
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    plan.errors.push(`cannot read spec ${specArg}`);
    return plan;
  }
  plan.hash = planHash(absPath).hash;

  if (!specPath.startsWith(".sddx/specs/") || specPath.slice(".sddx/specs/".length).includes("/")) {
    plan.errors.push(`${specPath}: a goal spec must live directly in .sddx/specs/`);
  } else if (!SPEC_NAME_RE.test(specPath.slice(".sddx/specs/".length))) {
    plan.errors.push(`${specPath}: a goal spec must be named <YYYY-MM-DD>-<slug>.md`);
  }

  if (!isCommitted(root, specPath)) {
    const slug = goalId.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    plan.errors.push(
      `${specPath} is not committed; commit it first so the plan you start is in history:\n  git add ${specPath} && git commit -m "plan: ${slug}"`,
    );
  }

  const { spec, errors } = parseGoalSpec(text);
  if (!spec) {
    plan.errors.push(...errors.map((e) => formatSpecError(specPath, e)));
    return plan;
  }
  plan.spec = spec;
  plan.errors.push(...planRuleErrors(spec));

  for (const t of spec.tasks) {
    const used = taskIdInUse(root, t.id);
    if (used)
      plan.errors.push(
        `task id ${t.id} is already used by ${used}; task ids are unique per repository`,
      );
  }
  if (goalExists(root, goalId)) plan.errors.push(`goal ${goalId} already exists`);
  if (branchExists(root, plan.runBranch)) {
    plan.errors.push(`run branch ${plan.runBranch} already exists`);
  }

  if (!worktreeAvailable(root)) {
    plan.errors.push(
      "worktree unavailable: git cannot create worktrees for this repository. Use a checkout where `git worktree list` succeeds.",
    );
    return plan;
  }
  const base = resolveBaseRef(root);
  plan.base = base;
  if (base.source === "HEAD") plan.notices.push("no origin remote: forking from local HEAD");
  for (const c of submoduleScopeConflicts(
    root,
    base.sha,
    spec.tasks.map((t) => ({ alias: t.id, scope: t.scope })),
  )) {
    plan.errors.push(
      c.scope
        ? `task ${c.alias} declares scope ${c.scope}, which reaches the submodule ${c.submodule}; a worktree crossing a submodule boundary is unsafe`
        : `task ${c.alias} declares no scope, so it cannot be proven disjoint from the submodule ${c.submodule}`,
    );
  }
  return plan;
}

export function gateNodes(spec: GoalSpec): GateNode[] {
  return spec.tasks.map((t) => ({ alias: t.id, scope: t.scope, oracleType: t.oracle.type }));
}

/** The approval decision for a resolved plan. Mode comes from config alone. */
export function decidePlanGate(plan: ResolvedPlan): GateDecision {
  const spec = plan.spec as GoalSpec;
  return decideGate(
    plan.root,
    plan.absPath,
    gateNodes(spec),
    gateInteractionMode(plan.root),
    autoMaxTasks(plan.root),
    scopesOverlap,
    spec.design.openDecisions,
  );
}

/** Undo log for `startPlan`: a failure partway must not leave half a goal behind. */
class Rollback {
  private steps: Array<{ describe: string; undo: () => void }> = [];

  add(describe: string, undo: () => void): void {
    this.steps.push({ describe, undo });
  }

  run(): string[] {
    const stuck: string[] = [];
    for (const step of [...this.steps].reverse()) {
      try {
        step.undo();
      } catch (e) {
        stuck.push(`${step.describe} (${(e as Error).message})`);
      }
    }
    return stuck;
  }
}

/**
 * Commits the spec file onto `branch` (currently at `parent`) without touching
 * any working tree or the real index, so the run branch, and every task forked
 * from it, carries the exact bytes that were approved.
 */
function commitSpecOnBranch(
  root: string,
  branch: string,
  parent: string,
  specPath: string,
  bytes: Buffer,
  message: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "sddx-plan-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const run = (args: string[], input?: Buffer): string => {
    const r = spawnSync("git", args, { cwd: root, env, input, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  try {
    run(["read-tree", parent]);
    const blob = run(["hash-object", "-w", "--stdin"], bytes);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${specPath}`]);
    const tree = run(["write-tree"]);
    const commit = run(["commit-tree", tree, "-p", parent, "-m", message]);
    run(["update-ref", `refs/heads/${branch}`, commit, parent]);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface StartedPlan {
  goalId: string;
  runBranch: string;
  baseSha: string;
  planCommit: string;
  taskIds: string[];
  wroteConfig: boolean;
}

/**
 * Materializes a resolved, gate-passed plan: the run branch with the spec
 * committed on it, one PLANNED task file per task, the goal record, and the
 * default config when the repository has none. All or nothing.
 */
export function startPlan(plan: ResolvedPlan, gate: GateDecision): StartedPlan {
  const spec = plan.spec as GoalSpec;
  const base = plan.base as BaseRef;
  const root = plan.root;
  const undo = new Rollback();
  try {
    createBranchAt(root, plan.runBranch, base.sha);
    undo.add(`branch ${plan.runBranch}`, () => {
      if (branchExists(root, plan.runBranch)) forceDeleteBranch(root, plan.runBranch);
    });
    const planCommit = commitSpecOnBranch(
      root,
      plan.runBranch,
      base.sha,
      plan.specPath,
      readFileSync(plan.absPath),
      `sddx: plan ${plan.goalId}`,
    );
    const goalAssumptions = spec.design.assumptions;
    const deps: Record<string, string[]> = {};
    for (const t of spec.tasks) {
      // registered only once the id is known to be free, so a rollback never
      // deletes a state file this attempt did not write
      if (existsSync(taskPath(root, t.id))) throw new Error(`task ${t.id} already exists`);
      undo.add(`task state ${t.id}`, () => rmSync(taskPath(root, t.id), { force: true }));
      createPlannedTask(root, {
        id: t.id,
        title: t.title,
        goal_id: plan.goalId,
        spec_path: plan.specPath,
        oracle: t.oracle,
        scope: t.scope,
        assumptions: mergeAssumptions(goalAssumptions, t.assumptions),
        depends_on: t.depends_on,
        ...(t.on_dependency_failure ? { on_dependency_failure: t.on_dependency_failure } : {}),
        ...(t.retry ? { retry: t.retry } : {}),
      });
      if (t.depends_on.length > 0) deps[t.id] = t.depends_on;
    }
    const goal = createGoal(
      root,
      spec.title,
      spec.tasks.map((t) => t.id),
      {
        id: plan.goalId,
        specPath: plan.specPath,
        runBranch: plan.runBranch,
        baseSha: base.sha,
        deps,
        approval: {
          mode: gate.mode,
          authorization: gate.mode === "human" ? "human-approval" : "auto",
          plan_sha256: gate.hash,
          at: new Date().toISOString(),
        },
      },
    );
    undo.add(`goal record ${plan.goalId}`, () => deleteCreatedGoal(root, goal));
    const wroteConfig = ensureConfig(root);
    return {
      goalId: plan.goalId,
      runBranch: plan.runBranch,
      baseSha: base.sha,
      planCommit,
      taskIds: spec.tasks.map((t) => t.id),
      wroteConfig,
    };
  } catch (e) {
    const stuck = undo.run();
    const suffix =
      stuck.length > 0
        ? ` Rollback could not remove: ${stuck.join("; ")}. Remove them by hand before retrying.`
        : " Everything this attempt created was rolled back.";
    throw new Error(`plan start failed: ${(e as Error).message}.${suffix}`);
  }
}

export const headOf = (root: string, ref: string): string => git(root, "rev-parse", ref);
