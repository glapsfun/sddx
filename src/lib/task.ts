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
  base_sha: string;
  /** Worktree path relative to the main repo root; absent for branch/none (M1 files). */
  path?: string;
}

export interface TaskState {
  id: string;
  task: string;
  phase: Phase;
  spec_path: string;
  oracle: Oracle;
  workspace: Workspace;
  allow: string[];
  iterations: number;
  /** Consecutive identical test failures; cleared by any pass or a different failure. */
  stuck?: { fingerprint: string; count: number; since: string };
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
): TaskState {
  const now = new Date().toISOString();
  const t: TaskState = {
    id: taskId(spec.task),
    task: spec.task,
    phase: "PLAN",
    spec_path: specPath,
    oracle: spec.oracle,
    workspace,
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
