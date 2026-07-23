import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRelPath } from "./classify";
import type { Oracle, Spec } from "./spec";

export type Phase = "PLAN" | "RED" | "GREEN" | "REFACTOR" | "VERIFY" | "DONE" | "ABANDONED";

export type EvidenceSource = "hook" | "manual";

export const TRANSITIONS: Record<Phase, Phase[]> = {
  PLAN: ["RED", "ABANDONED"],
  RED: ["GREEN", "ABANDONED"],
  GREEN: ["REFACTOR", "VERIFY", "ABANDONED"],
  REFACTOR: ["GREEN", "VERIFY", "ABANDONED"],
  VERIFY: ["DONE", "ABANDONED"],
  DONE: [],
  ABANDONED: [],
};

export interface Workspace {
  mode: "worktree" | "branch" | "none";
  branch: string | null;
  /** Fork point once resolved. For a dependent task not yet materialized this is
   * `pending:<parent-id>` — the real SHA is filled in when its worktree is created
   * from the parent's DONE commit (see materializeDependent in worktree.ts). */
  base_sha: string;
  /** Worktree path relative to the main repo root; absent for branch/none, or for a
   * dependent task whose worktree has not been materialized yet. */
  path?: string;
}

export type DependencyFailurePolicy = "skip" | "block";

export interface RetryPolicy {
  max_attempts: number;
  workspace: "fresh" | "reuse";
}

export const DEFAULT_RETRY: RetryPolicy = { max_attempts: 1, workspace: "fresh" };

export interface TaskState {
  id: string;
  task: string;
  phase: Phase;
  spec_path: string;
  oracle: Oracle;
  workspace: Workspace;
  /** Write globs the task may touch, copied from the spec. Empty = unconfined. */
  scope: string[];
  /** Zero or more predecessor task ids (a DAG, not just a forest). Absent/empty
   * for a root task. A dependent runs only once every named parent is DONE and
   * forks its worktree from the parent's commit (or a merge of several — see
   * `materializeDependent` in worktree.ts). A bare string is the pre-DAG shape
   * still readable via `dependsOnList()`. */
  depends_on?: string | string[];
  /** What a dependent of this task does if this task never reaches DONE (goes
   * ABANDONED). Default `skip` when absent — read via `failurePolicyOf()`. */
  on_dependency_failure?: DependencyFailurePolicy;
  /** Bounded automatic retry before this task is truly ABANDONED. Absent means
   * `DEFAULT_RETRY` (single attempt, today's behavior) — read via `retryPolicyOf()`. */
  retry?: Partial<RetryPolicy>;
  /** Attempts consumed so far, starting at 1. Incremented by `abandonOrRetry`. */
  attempt_count?: number;
  allow: string[];
  iterations: number;
  /** Consecutive identical test failures; cleared by any pass or a different failure. */
  stuck?: { fingerprint: string; count: number; since: string };
  /** Set once by `sddx pr create` after this task's commit ships in a goal PR. */
  shipped?: { goal_id: string; pr_url: string; at: string };
  evidence: Record<
    string,
    {
      test_exit?: number;
      exit_code?: number;
      at: string;
      source?: EvidenceSource;
      stdout_sha256?: string;
      stderr_sha256?: string;
    }
  >;
  history: Array<{ phase: Phase; at: string }>;
  created_at: string;
  updated_at: string;
}

/** Normalizes `depends_on` to a list regardless of the on-disk shape: absent → `[]`,
 * a legacy bare string → a one-element list, an array → itself. */
export function dependsOnList(t: { depends_on?: string | string[] }): string[] {
  const d = t.depends_on;
  if (d === undefined) return [];
  return Array.isArray(d) ? d : [d];
}

export function retryPolicyOf(t: { retry?: Partial<RetryPolicy> }): RetryPolicy {
  return { ...DEFAULT_RETRY, ...t.retry };
}

export function failurePolicyOf(t: {
  on_dependency_failure?: DependencyFailurePolicy;
}): DependencyFailurePolicy {
  return t.on_dependency_failure ?? "skip";
}

export const sddxDir = (cwd: string): string => join(cwd, ".sddx");
export const taskPath = (cwd: string, id: string): string =>
  join(sddxDir(cwd), "tasks", `${id}.json`);

export function taskId(sentence: string, date = new Date()): string {
  const slug = sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${ymd}-${slug}`;
}

export function createTask(
  cwd: string,
  spec: Spec,
  specPath: string,
  workspace: Workspace,
  opts: { dependsOn?: string | string[] } = {},
): TaskState {
  const now = new Date().toISOString();
  const dependsOn =
    opts.dependsOn === undefined ? [] : dependsOnList({ depends_on: opts.dependsOn });
  const t: TaskState = {
    id: taskId(spec.task),
    task: spec.task,
    phase: "PLAN",
    spec_path: specPath,
    oracle: spec.oracle,
    workspace,
    scope: spec.scope,
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
    ...(spec.on_dependency_failure ? { on_dependency_failure: spec.on_dependency_failure } : {}),
    ...(spec.retry ? { retry: spec.retry } : {}),
    attempt_count: 1,
    allow: [],
    iterations: 0,
    evidence: {},
    history: [{ phase: "PLAN", at: now }],
    created_at: now,
    updated_at: now,
  };
  const path = taskPath(cwd, t.id);
  if (existsSync(path)) throw new Error(`task ${t.id} already exists at ${path}`);
  mkdirSync(join(sddxDir(cwd), "tasks"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
  return t;
}

export function readTask(cwd: string, id: string): TaskState {
  const path = taskPath(cwd, id);
  if (!existsSync(path)) throw new Error(`no such task: ${id} (${path})`);
  return JSON.parse(readFileSync(path, "utf8")) as TaskState;
}

export function writeTask(cwd: string, t: TaskState): void {
  t.updated_at = new Date().toISOString();
  writeFileSync(taskPath(cwd, t.id), `${JSON.stringify(t, null, 2)}\n`);
}

export function transition(
  t: TaskState,
  to: Phase,
  opts: { testExit?: number; internal?: boolean; source?: EvidenceSource } = {},
): TaskState {
  if (!TRANSITIONS[t.phase].includes(to)) {
    throw new Error(`illegal transition ${t.phase} → ${to}`);
  }
  const at = new Date().toISOString();
  const source = opts.source ?? "manual";
  if (to === "RED") {
    if (opts.testExit === undefined || opts.testExit === 0) {
      throw new Error("RED requires evidence of a failing test: --test-exit <nonzero exit code>");
    }
    t.evidence.red = { test_exit: opts.testExit, at, source };
  }
  if (to === "GREEN") {
    if (opts.testExit !== 0) {
      throw new Error("GREEN requires evidence of a passing test: --test-exit 0");
    }
    t.evidence.green = { test_exit: 0, at, source };
  }
  if (to === "DONE" && !opts.internal) {
    throw new Error("DONE is set by the verifier, not by phase transitions");
  }
  t.phase = to;
  t.history.push({ phase: to, at });
  return t;
}

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(["DONE", "ABANDONED"]);
export const isTerminal = (phase: Phase): boolean => TERMINAL_PHASES.has(phase);

/**
 * The audited TDD-gate escape hatch: exact repo-relative paths only. Idempotent;
 * the verifier copies the final list into the receipt.
 */
export function allowPath(t: TaskState, path: string): TaskState {
  if (isTerminal(t.phase)) {
    throw new Error(`task ${t.id} is ${t.phase}; allow-list is frozen on terminal tasks`);
  }
  const normalized = normalizeRelPath(path);
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`allow requires a repo-relative path, got: ${path}`);
  }
  if (!t.allow.includes(normalized)) t.allow.push(normalized);
  return t;
}

/**
 * The first named parent that is not yet DONE, or null when the task is ready
 * to dispatch (a root, or every named parent DONE). Derived at read time from
 * `depends_on` plus each parent's phase (resolved wherever it lives — main
 * checkout, live worktree, or a swept task's branch tip) — "blocked" is never a
 * persisted phase. A missing parent blocks too (its id is returned). Only the
 * task's *direct* parents are checked — a parent that is itself DONE already
 * had its own parents satisfied, so there is nothing further to walk up.
 * Applies regardless of `on_dependency_failure`: a `block`-policy task stays
 * blocked here even once a parent goes ABANDONED (see `skippedOn` for the
 * `skip`-policy reaction to that same fact). Takes a structural subset of
 * TaskState so the board can share this one derivation.
 */
export function blockedOn(
  cwd: string,
  task: { id: string; depends_on?: string | string[] },
): string | null {
  for (const parentId of dependsOnList(task)) {
    if (parentId === task.id) continue;
    const parent = resolveTaskState(cwd, parentId);
    if (parent?.phase !== "DONE") return parentId;
  }
  return null;
}

/**
 * The first named parent whose terminal failure this task (a `skip`-policy
 * dependent, the default) reacts to by skipping — or null when no parent has
 * failed, or when this task's own policy is `block` (see `blockedOn` for that
 * case). A parent counts as failed either directly (ABANDONED) or by itself
 * being derived-skipped, so the cascade propagates transitively down a chain
 * of skip-policy tasks. `seen` guards against a malformed cyclic file.
 */
export function skippedOn(
  cwd: string,
  task: {
    id: string;
    depends_on?: string | string[];
    on_dependency_failure?: DependencyFailurePolicy;
  },
  seen: Set<string> = new Set(),
): string | null {
  if (failurePolicyOf(task) !== "skip") return null;
  if (seen.has(task.id)) return null;
  seen.add(task.id);
  for (const parentId of dependsOnList(task)) {
    if (parentId === task.id) continue;
    const parent = resolveTaskState(cwd, parentId);
    if (!parent) continue; // a missing (not-yet-existing) parent is blockedOn's concern, not a failure
    if (parent.phase === "ABANDONED") return parentId;
    if (skippedOn(cwd, parent, seen)) return parentId;
  }
  return null;
}

export interface RetryOutcome {
  retried: boolean;
  attempt_count: number;
  max_attempts: number;
}

/**
 * The retry gate that stands in front of a manual/automatic ABANDONED
 * transition: if attempts remain under the task's `retry` policy, the task is
 * reset to PLAN for another attempt instead of going terminal. This bypasses
 * `transition()`'s TRANSITIONS map on purpose — a retry is a full loop reset,
 * not a normal forward phase move. Workspace handling (fresh re-fork vs reuse)
 * is the caller's job (see `retryWorkspace` in worktree.ts), since only the
 * caller knows how to reach git.
 */
export function abandonOrRetry(t: TaskState): RetryOutcome {
  if (isTerminal(t.phase)) {
    throw new Error(`illegal transition ${t.phase} → ABANDONED`);
  }
  const policy = retryPolicyOf(t);
  const attempts = t.attempt_count ?? 1;
  const at = new Date().toISOString();
  if (attempts < policy.max_attempts) {
    t.attempt_count = attempts + 1;
    t.phase = "PLAN";
    t.iterations = 0;
    t.evidence = {};
    t.stuck = undefined;
    t.history.push({ phase: "PLAN", at });
    return { retried: true, attempt_count: t.attempt_count, max_attempts: policy.max_attempts };
  }
  t.phase = "ABANDONED";
  t.history.push({ phase: "ABANDONED", at });
  return { retried: false, attempt_count: attempts, max_attempts: policy.max_attempts };
}

export function markShipped(t: TaskState, goalId: string, prUrl: string): TaskState {
  t.shipped = { goal_id: goalId, pr_url: prUrl, at: new Date().toISOString() };
  return t;
}

function readTaskFrom(dir: string, id: string): TaskState | null {
  try {
    return JSON.parse(readFileSync(taskPath(dir, id), "utf8")) as TaskState;
  } catch {
    return null;
  }
}

function readTaskFromBranch(cwd: string, id: string): TaskState | null {
  const r = spawnSync("git", ["show", `sddx/${id}:.sddx/tasks/${id}.json`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as TaskState;
  } catch {
    return null;
  }
}

/**
 * Resolves a task's state wherever it currently lives: a live worktree (the
 * source of truth while work is in progress), the main checkout (branch/none
 * mode), or the tip of the task's own branch once its worktree has been swept.
 * Unlike `readTask`, never throws — callers that need "does this task exist
 * at all" get `null` instead of an exception.
 */
export function resolveTaskState(cwd: string, id: string): TaskState | null {
  return (
    readTaskFrom(join(cwd, ".sddx-worktrees", id), id) ??
    readTaskFrom(cwd, id) ??
    readTaskFromBranch(cwd, id)
  );
}
