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
  /**
   * `deferred` means the task has no workspace YET — a dependent whose parents
   * are not all DONE. It is a distinct mode rather than an inference from
   * `base_sha` because the inference was load-bearing and invisible: a deferred
   * task's state lives in the main checkout (it has nowhere else to go), and
   * anything scanning for "the active task here" counted it, so a single
   * deferred dependent claimed the user's own checkout and blocked their edits.
   */
  mode: "worktree" | "branch" | "none" | "deferred";
  branch: string | null;
  /** Fork point once resolved. While deferred this is `pending:<parent-id>[,...]`,
   * which names the parents; the real SHA replaces it when the workspace is built
   * from their DONE commits (see materializeDependent in worktree.ts). */
  base_sha: string;
  /** What `mode` becomes on materialization. Set only while deferred. */
  materialize_as?: "worktree" | "branch";
  /** Worktree path relative to the main repo root; absent for branch/none/deferred,
   * or for a dependent task whose worktree has not been materialized yet. */
  path?: string;
}

/**
 * Has this task no workspace yet?
 *
 * Reads the typed mode first, then falls back to the `pending:` base that older
 * state used. The fallback is not optional: a repository upgraded mid-run has
 * deferred tasks on disk written under the previous shape, and reading those as
 * active would reintroduce the checkout block on exactly the users who already
 * had a run going.
 */
export const isDeferred = (t: TaskState): boolean => {
  // Defensive on purpose. This runs on the PreToolUse hot path via
  // `resolveTask`, OUTSIDE the try/catch that turns unreadable state into
  // `{kind: "corrupt"}`. A task file that parses as JSON but has no
  // `workspace` — written by an older sddx, or hand-edited — would throw from
  // here, the hook would catch it and emit a message with no permission
  // decision, and the TDD gate would silently stop denying. A broken state
  // file must not disable the gate.
  const w = t.workspace as Workspace | undefined;
  if (!w || typeof w !== "object") return false;
  return (
    w.mode === "deferred" || (typeof w.base_sha === "string" && w.base_sha.startsWith("pending:"))
  );
};

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
  /** Decisions resolved without asking, copied from the spec (goal-level ones
   * denormalized in at plan-creation time) and carried into the receipt. */
  assumptions?: string[];
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
  /** Set once, after DONE, by the run-branch integration step (see
   * `run-branch-integration`) — a board-visible mirror of the task's most
   * recent entry in its goal's `merges` log. Absent for a task with no goal,
   * or one created in `--workspace none` mode (no branch to integrate). */
  integration?: {
    run_branch: string;
    merge_commit?: string;
    merged_at?: string;
    result: "merged" | "conflict" | "reverted";
  };
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
    ...(spec.assumptions.length > 0 ? { assumptions: spec.assumptions } : {}),
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

/** Workspace modes no creation path can produce any more. Reading them is
 * supported forever; advancing a task that records one is not. */
const LEGACY_WORKSPACE_MODES: ReadonlySet<string> = new Set(["branch", "none"]);

/**
 * The legacy workspace mode this task records, or `null` if it records none.
 *
 * A DEFERRED task is the subtle case: its `mode` is `"deferred"`, so looking at
 * `mode` alone sees nothing legacy — the mode it would become on materialization
 * lives in `materialize_as`. Missing that let a 3.x dependent recorded as
 * `materialize_as: "branch"` be silently materialized as a worktree, which is
 * exactly the unsafe workspace branch mode existed to avoid.
 */
export function legacyWorkspaceOf(t: TaskState): string | null {
  const w = t.workspace as Workspace | undefined;
  if (!w || typeof w !== "object") return null;
  for (const candidate of [w.mode, w.materialize_as]) {
    if (typeof candidate === "string" && LEGACY_WORKSPACE_MODES.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Refuse to advance an unfinished task written by an older sddx.
 *
 * `branch` and `none` were real workspace strategies until 4.0. Since no
 * creation path can produce them now, a task on disk recording one is
 * unambiguously historical — which is exactly what makes this check possible.
 * While `--workspace branch|none` still existed, current and legacy state were
 * indistinguishable and refusing would have broken working repositories.
 *
 * Scoped to UNFINISHED tasks on purpose. A completed legacy task has a receipt
 * and is immutable history: it must keep auditing and displaying normally, so
 * `board`, `audit`, and `task show` never come through here.
 *
 * Abandoning is deliberately NOT routed through here — see `abandonOrRetry`.
 * Refusing it too would strand a legacy task with no way to close it out, and
 * the message below promises exactly that remedy.
 */
export function assertAdvanceable(t: TaskState): void {
  const mode = legacyWorkspaceOf(t);
  if (mode === null || isTerminal(t.phase)) return;
  throw new Error(
    `task ${t.id} records the "${mode}" workspace mode, which was removed in sddx 4.0, and is unfinished (phase ${t.phase}). ` +
      "It cannot be advanced by this version. Either complete it with a compatible older sddx (3.x), " +
      `or close it out with \`sddx task phase ${t.id} ABANDONED\` and recreate the work as a canonical run with \`sddx graph create\`. ` +
      "Its state has not been modified.",
  );
}

export function transition(
  t: TaskState,
  to: Phase,
  opts: { testExit?: number; internal?: boolean; source?: EvidenceSource } = {},
): TaskState {
  assertAdvanceable(t);
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
  assertAdvanceable(t);
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
  // A legacy task may be CLOSED (that is the documented way out) but never
  // RETRIED: a retry resets it to PLAN and re-runs the workspace policy, which
  // is resumption under a mode this version cannot build. Going terminal below
  // is safe and leaves the user an exit; retrying would erase the very evidence
  // an older sddx would resume from, while the refusal elsewhere promises that
  // state was not modified.
  const legacy = legacyWorkspaceOf(t);
  if (attempts < policy.max_attempts && legacy !== null) {
    t.phase = "ABANDONED";
    t.history.push({ phase: "ABANDONED", at });
    return { retried: false, attempt_count: attempts, max_attempts: policy.max_attempts };
  }
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
