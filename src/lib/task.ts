import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { normalizeRelPath } from "./classify";
import type { OracleRun } from "./receipt";
import type { Oracle } from "./spec";

/**
 * The v6 lifecycle. RED/GREEN no longer live here: in every profile the
 * boundary proof in `sddx verify` is what shows the tests discriminate the
 * change, and the strict profile's per-edit evidence is a sub-record
 * (`strict`), so the lifecycle reads the same whichever profile gated it.
 */
export type Phase = "PLANNED" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "ABANDONED";
export type Profile = "default" | "strict";
export type EvidenceSource = "hook" | "manual";

/** Distinguishes a v6 task file from a v5 one, which has no `schema` key. */
export const TASK_SCHEMA = 2;

export const TRANSITIONS: Record<Phase, Phase[]> = {
  PLANNED: ["IN_PROGRESS", "ABANDONED"],
  IN_PROGRESS: ["IN_REVIEW", "ABANDONED"],
  IN_REVIEW: ["DONE", "IN_PROGRESS", "ABANDONED"],
  DONE: [],
  ABANDONED: [],
};

export type DependencyFailurePolicy = "skip" | "block";

export interface RetryPolicy {
  max_attempts: number;
  workspace: "fresh" | "reuse";
}

export const DEFAULT_RETRY: RetryPolicy = { max_attempts: 1, workspace: "fresh" };

/** Present once `task start` built the task's worktree. */
export interface Workspace {
  branch: string;
  /** The commit the worktree was forked from: the boundary proof's base. */
  base_sha: string;
  /** Relative to the main repository root. */
  path: string;
}

/** What `sddx verify` proved, recorded on a pass. */
export interface VerifiedRecord {
  base_sha: string;
  tree_sha: string;
  test_files: string[];
  red: { exit_code: number; stdout_sha256: string; stderr_sha256: string };
  green: OracleRun[];
  at: string;
}

export interface VerifyFailure {
  half: "scope" | "setup" | "red" | "green";
  exit_code: number;
  message: string;
  at: string;
}

export interface ReviewEntry {
  verdict: "pass" | "fail";
  diff_sha256: string;
  tree_sha: string;
  reviewer: string | null;
  findings_path?: string;
  findings_sha256?: string;
  at: string;
}

export interface StrictRun {
  test_exit: number;
  source: EvidenceSource;
  at: string;
}

/** Per-edit evidence, recorded only for a task started under the strict profile. */
export interface StrictEvidence {
  phase?: "RED" | "GREEN";
  runs: StrictRun[];
}

export interface TaskState {
  schema: typeof TASK_SCHEMA;
  id: string;
  /** The task's title from its spec heading. */
  task: string;
  goal_id: string;
  /** Repository-relative path of the goal spec. */
  spec_path: string;
  phase: Phase;
  /** Recorded by `task start`; absent while PLANNED. */
  profile?: Profile;
  oracle: Oracle;
  /** Write globs the task may touch. Empty = unconfined. */
  scope: string[];
  assumptions?: string[];
  depends_on?: string[];
  on_dependency_failure?: DependencyFailurePolicy;
  retry?: Partial<RetryPolicy>;
  attempt_count: number;
  /** Verify runs and failed reviews in the current attempt; bounded by stop rules. */
  iterations: number;
  workspace?: Workspace;
  verified?: VerifiedRecord;
  last_failure?: VerifyFailure;
  reviews: ReviewEntry[];
  abandon_reason?: string;
  /** Set only when sddx abandoned this task because dependency `skipped_on` was abandoned. */
  skipped_on?: string;
  /** Consecutive identical verify failures; cleared by a pass or a different failure. */
  stuck?: { fingerprint: string; count: number; since: string };
  strict?: StrictEvidence;
  /** Strict-profile gate exemptions, exact repo-relative paths. */
  allow: string[];
  /** Mirror of the task's latest entry in its goal's merge log. */
  integration?: {
    run_branch: string;
    merge_commit?: string;
    merged_at?: string;
    result: "merged" | "conflict" | "reverted";
  };
  history: Array<{ phase: Phase; at: string; note?: string }>;
  created_at: string;
  updated_at: string;
}

export function dependsOnList(t: { depends_on?: string | string[] }): string[] {
  if (t.depends_on === undefined) return [];
  return Array.isArray(t.depends_on) ? t.depends_on : [t.depends_on];
}

export function retryPolicyOf(t: { retry?: Partial<RetryPolicy> }): RetryPolicy {
  return { ...DEFAULT_RETRY, ...(t.retry ?? {}) };
}

export function failurePolicyOf(t: {
  on_dependency_failure?: DependencyFailurePolicy;
}): DependencyFailurePolicy {
  return t.on_dependency_failure ?? "skip";
}

export const sddxDir = (cwd: string): string => join(cwd, ".sddx");
export const taskPath = (cwd: string, id: string): string =>
  join(sddxDir(cwd), "tasks", `${id}.json`);

/** The main checkout for a path inside `.sddx-worktrees/<id>`, read textually so
 * hot paths never spawn git. Any other path is returned unchanged. */
export function mainRootOf(cwd: string): string {
  const abs = resolve(cwd);
  const marker = `${sep}.sddx-worktrees${sep}`;
  const at = abs.indexOf(marker);
  return at === -1 ? abs : abs.slice(0, at);
}

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(["DONE", "ABANDONED"]);
export const isTerminal = (phase: Phase): boolean => TERMINAL_PHASES.has(phase);
export const isStarted = (t: TaskState): boolean => t.workspace !== undefined;

/** True for a state file written by sddx 6 or later. */
export const isV6Task = (raw: unknown): raw is TaskState =>
  typeof raw === "object" && raw !== null && (raw as { schema?: unknown }).schema === TASK_SCHEMA;

export interface PlannedTaskInput {
  id: string;
  title: string;
  goal_id: string;
  spec_path: string;
  oracle: Oracle;
  scope: string[];
  assumptions: string[];
  depends_on: string[];
  on_dependency_failure?: DependencyFailurePolicy;
  retry?: Partial<RetryPolicy>;
}

/** Writes a PLANNED task to the main checkout, where it lives until `task start`. */
export function createPlannedTask(root: string, input: PlannedTaskInput): TaskState {
  const now = new Date().toISOString();
  const t: TaskState = {
    schema: TASK_SCHEMA,
    id: input.id,
    task: input.title,
    goal_id: input.goal_id,
    spec_path: input.spec_path,
    phase: "PLANNED",
    oracle: input.oracle,
    scope: input.scope,
    ...(input.assumptions.length > 0 ? { assumptions: input.assumptions } : {}),
    ...(input.depends_on.length > 0 ? { depends_on: input.depends_on } : {}),
    ...(input.on_dependency_failure ? { on_dependency_failure: input.on_dependency_failure } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
    attempt_count: 1,
    iterations: 0,
    reviews: [],
    allow: [],
    history: [{ phase: "PLANNED", at: now }],
    created_at: now,
    updated_at: now,
  };
  const path = taskPath(root, t.id);
  if (existsSync(path)) throw new Error(`task ${t.id} already exists at ${path}`);
  mkdirSync(dirname(path), { recursive: true });
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
  mkdirSync(join(sddxDir(cwd), "tasks"), { recursive: true });
  writeFileSync(taskPath(cwd, t.id), `${JSON.stringify(t, null, 2)}\n`);
}

/** Refuses a state file this version did not write, before anything acts on it. */
export function assertV6(t: TaskState): void {
  if (!isV6Task(t)) {
    throw new Error(
      `task ${(t as { id?: string }).id ?? "?"} was written by sddx 5 or earlier and cannot be advanced by this version. Run \`sddx migrate\`.`,
    );
  }
}

export function transition(t: TaskState, to: Phase, note?: string): TaskState {
  assertV6(t);
  if (!TRANSITIONS[t.phase].includes(to)) {
    throw new Error(`task ${t.id}: illegal transition ${t.phase} -> ${to}`);
  }
  t.phase = to;
  t.history.push({ phase: to, at: new Date().toISOString(), ...(note ? { note } : {}) });
  return t;
}

/** Strict-profile escape hatch: exact repo-relative paths, listed on the receipt. */
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
 * The first named parent that is not yet DONE, or null when the task may start.
 * Derived at read time from each parent's state wherever it lives; "blocked" is
 * never persisted. A missing parent blocks too.
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
 * The first parent whose failure a `skip`-policy task reacts to: a parent that
 * is ABANDONED, directly or through its own skipped ancestry. Null for a
 * `block`-policy task, which stays blocked instead.
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
    if (!parent) continue;
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
 * Abandons a task, or, when a started task's retry policy has attempts left,
 * returns it to PLANNED for another attempt. Workspace handling is the caller's
 * job, since only the caller can reach git.
 */
export function abandonOrRetry(t: TaskState, reason: string): RetryOutcome {
  assertV6(t);
  if (isTerminal(t.phase)) {
    throw new Error(`task ${t.id}: illegal transition ${t.phase} -> ABANDONED`);
  }
  const policy = retryPolicyOf(t);
  const attempts = t.attempt_count ?? 1;
  const at = new Date().toISOString();
  t.abandon_reason = reason;
  // a retry replaces a failed attempt; a task still PLANNED has none to replace
  if (t.phase !== "PLANNED" && attempts < policy.max_attempts) {
    t.attempt_count = attempts + 1;
    t.phase = "PLANNED";
    t.iterations = 0;
    t.verified = undefined;
    t.last_failure = undefined;
    t.stuck = undefined;
    t.strict = undefined;
    t.history.push({ phase: "PLANNED", at, note: `retry after: ${reason}` });
    return { retried: true, attempt_count: t.attempt_count, max_attempts: policy.max_attempts };
  }
  t.phase = "ABANDONED";
  t.history.push({ phase: "ABANDONED", at, note: reason });
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
 * A task's state wherever it lives: its live worktree, the main checkout (while
 * PLANNED), or the tip of its own branch once the worktree was swept. Never throws.
 */
export function resolveTaskState(cwd: string, id: string): TaskState | null {
  const root = mainRootOf(cwd);
  return (
    readTaskFrom(join(root, ".sddx-worktrees", id), id) ??
    readTaskFrom(root, id) ??
    readTaskFromBranch(root, id)
  );
}

/** Where a task's state file currently lives, for commands that update it. */
export function taskHome(cwd: string, id: string): string | null {
  const root = mainRootOf(cwd);
  const wt = join(root, ".sddx-worktrees", id);
  if (existsSync(taskPath(wt, id))) return wt;
  if (existsSync(taskPath(root, id))) return root;
  return null;
}
