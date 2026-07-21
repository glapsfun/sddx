// The TDD gate: pure decision logic for the PreToolUse hook on Edit/Write-family
// tools. Hard-block, no soft mode — in RED, implementation paths are denied until
// a failing test has been observed. The entrypoint I/O lives in src/hooks.ts.
import { isAbsolute, relative, resolve } from "node:path";
import {
  BUILTIN_TEST_GLOBS,
  type ClassifyConfig,
  classify,
  normalizeRelPath,
} from "./lib/classify";
import { readConfig } from "./lib/config";
import { globMatch } from "./lib/glob";
import { resolutionFailureReason, resolveTask } from "./lib/resolve";
import type { TaskState } from "./lib/task";

export type GateDecision = { allow: true; diagnostic?: string } | { allow: false; reason: string };

export interface GateInput {
  /** Target of the Edit/Write, absolute or cwd-relative. */
  filePath?: string;
  cwd?: string;
  config?: ClassifyConfig;
}

/** userConfig globs: env wins, then the workspace's .sddx/config.json. */
export function loadGateConfig(root: string, env = process.env): ClassifyConfig {
  const fileConfig = readConfig(root);
  return {
    testGlobs: env.SDDX_TEST_GLOBS ?? fileConfig.test_globs,
    exemptGlobs: env.SDDX_EXEMPT_GLOBS ?? fileConfig.exempt_globs,
  };
}

export function blockMessage(task: TaskState, relPath: string, config: ClassifyConfig): string {
  const testGlobs = [
    ...BUILTIN_TEST_GLOBS,
    ...(config.testGlobs ?? "").split(/\s+/).filter((g) => g !== ""),
  ];
  return [
    `sddx TDD gate: blocked write to ${relPath} — task ${task.id} is in ${task.phase} (rule: implementation path).`,
    `Before GREEN, only test files may change. Do this instead:`,
    `  1. Write a failing test for "${task.task}" under a test path (${testGlobs.slice(0, 4).join(", ")}, …).`,
    "  2. Run the test runner so the failure is recorded (the gate lifts in GREEN).",
    `  3. Only for files that genuinely cannot be test-driven: sddx task allow ${task.id} ${relPath} — the exemption is audited in the receipt.`,
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
    `sddx TDD gate: blocked write to ${relPath} — outside task ${task.id}'s declared scope.`,
    `This task may only write: ${scope.join(", ")}.`,
    "Do one of:",
    "  1. Write inside the declared scope.",
    `  2. If this file genuinely belongs to the task, widen its spec's scope and re-create the task.`,
    `  3. For a one-off exception: sddx task allow ${task.id} ${relPath} — audited in the receipt.`,
  ].join("\n");
}

export function tddGate(input: GateInput, env = process.env): GateDecision {
  const anchor = input.filePath
    ? isAbsolute(input.filePath)
      ? input.filePath
      : resolve(input.cwd ?? process.cwd(), input.filePath)
    : (input.cwd ?? process.cwd());

  const res = resolveTask(anchor);
  if (res.kind === "none") return { allow: true };
  const failure = resolutionFailureReason(res, "writing");
  if (failure) return { allow: false, reason: failure };
  if (res.kind !== "task") return { allow: true };
  if (!input.filePath) return { allow: true }; // no target to classify (non-file event)

  const relPath = relative(res.root, anchor);
  const config = input.config ?? loadGateConfig(res.root, env);
  const cls = classify(relPath, res.task.allow, config);

  // Test-first: pre-GREEN, an implementation write is blocked outright — "implementation
  // -first" is exactly a write attempted before GREEN evidence.
  if ((res.task.phase === "PLAN" || res.task.phase === "RED") && cls.rule === "implementation") {
    return { allow: false, reason: blockMessage(res.task, relPath, config) };
  }

  // Scope confinement: an implementation write outside the declared lane is blocked
  // in ANY phase. `classify` already gave exempt globs and the allow-list precedence,
  // so they permit the write before we reach here.
  const scope = res.task.scope ?? [];
  if (cls.rule === "implementation" && scope.length > 0 && !inScope(relPath, scope)) {
    return { allow: false, reason: scopeBlockMessage(res.task, relPath, scope) };
  }

  return { allow: true };
}
