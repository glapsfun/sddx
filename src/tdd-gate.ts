// The strict profile's per-edit test-first gate, for the PreToolUse hook on
// Edit/Write-family tools. In the default profile it never denies and never reads
// task state: the boundary proof in `sddx verify` carries the guarantee there.
// Under `strict`, implementation writes are denied until a failing test run has
// been recorded for the task, and writes outside its scope are denied always.
import { relative, resolve } from "node:path";
import {
  BUILTIN_TEST_GLOBS,
  type ClassifyConfig,
  classify,
  normalizeRelPath,
} from "./lib/classify";
import { classifyConfig, profile } from "./lib/config";
import { globMatch } from "./lib/glob";
import { resolutionFailureReason, resolveTask, workspaceRoot } from "./lib/resolve";
import { mainRootOf, type TaskState } from "./lib/task";

export type GateDecision = { allow: true; diagnostic?: string } | { allow: false; reason: string };

export interface GateInput {
  /** Target of the Edit/Write, absolute or cwd-relative. */
  filePath?: string;
  cwd?: string;
  config?: ClassifyConfig;
}

export function blockMessage(task: TaskState, relPath: string, config: ClassifyConfig): string {
  const testGlobs = [
    ...BUILTIN_TEST_GLOBS,
    ...(config.testGlobs ?? "").split(/\s+/).filter((g) => g !== ""),
  ];
  return [
    `sddx strict gate: blocked write to ${relPath}; task ${task.id} has no recorded failing test yet (rule: implementation path).`,
    "Under the strict profile, only test files may change until a test has been seen failing. Do this instead:",
    `  1. Write a failing test for "${task.task}" under a test path (${testGlobs.slice(0, 4).join(", ")}, ...).`,
    "  2. Run the test runner so the failure is recorded; the gate lifts once it is.",
    `  3. Only for files that genuinely cannot be test-driven: sddx task allow ${task.id} ${relPath}; the exemption is listed on the receipt.`,
  ].join("\n");
}

/** A declared scope confines only implementation writes to their lane. Empty
 * scope = unconfined. Exempt/test/allow paths are handled by `classify` before
 * this is consulted, so an out-of-lane path here is genuinely off-scope. */
function inScope(relPath: string, scope: readonly string[]): boolean {
  const path = normalizeRelPath(relPath);
  return scope.some((glob) => globMatch(normalizeRelPath(glob), path));
}

export function scopeBlockMessage(
  task: TaskState,
  relPath: string,
  scope: readonly string[],
): string {
  return [
    `sddx strict gate: blocked write to ${relPath}; it is outside task ${task.id}'s declared scope.`,
    `This task may only write: ${scope.join(", ")}.`,
    "Do one of:",
    "  1. Write inside the declared scope.",
    "  2. If this file genuinely belongs to the task, widen the scope in its goal spec and plan again.",
    `  3. For a one-off exception: sddx task allow ${task.id} ${relPath}; it is listed on the receipt.`,
  ].join("\n");
}

export function tddGate(input: GateInput, env = process.env): GateDecision {
  const cwd = input.cwd ?? process.cwd();
  if (!input.filePath) return { allow: true };
  // `resolve` normalizes, so `src/x/../y` is judged as the path it reaches
  const anchor = resolve(cwd, input.filePath);
  // The written file's repository decides the profile, never the caller's cwd:
  // a hook event from elsewhere must not switch a strict repository's gate off.
  const repo = workspaceRoot(anchor);
  if (!repo || profile(mainRootOf(repo)) !== "strict") return { allow: true };
  const res = resolveTask(anchor);
  if (res.kind === "none") return { allow: true };
  const failure = resolutionFailureReason(res, "writing");
  if (failure) return { allow: false, reason: failure };
  if (res.kind !== "task") return { allow: true };
  const task = res.task;
  if (task.phase !== "IN_PROGRESS" || task.profile !== "strict") return { allow: true };

  const relPath = relative(res.root, anchor);
  const config = input.config ?? classifyConfig(mainRootOf(res.root), env);
  const cls = classify(relPath, task.allow, config);
  if (cls.rule !== "implementation") return { allow: true };
  if (!task.strict?.phase) {
    return { allow: false, reason: blockMessage(task, relPath, config) };
  }
  const scope = task.scope ?? [];
  if (scope.length > 0 && !inScope(relPath, scope)) {
    return { allow: false, reason: scopeBlockMessage(task, relPath, scope) };
  }
  return { allow: true };
}
