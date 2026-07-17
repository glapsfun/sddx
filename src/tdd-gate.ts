// The TDD gate: pure decision logic for the PreToolUse hook on Edit/Write-family
// tools. Hard-block, no soft mode — in RED, implementation paths are denied until
// a failing test has been observed. The entrypoint I/O lives in src/hooks.ts.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BUILTIN_TEST_GLOBS, type ClassifyConfig, classify } from "./lib/classify";
import { resolveTask } from "./lib/resolve";
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
  let fileConfig: { test_globs?: string; exempt_globs?: string } = {};
  const path = join(root, ".sddx", "config.json");
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // unreadable config never disables the gate — built-ins still apply
    }
  }
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

export function tddGate(input: GateInput, env = process.env): GateDecision {
  const anchor = input.filePath
    ? isAbsolute(input.filePath)
      ? input.filePath
      : resolve(input.cwd ?? process.cwd(), input.filePath)
    : (input.cwd ?? process.cwd());

  const res = resolveTask(anchor);
  if (res.kind === "none") return { allow: true };
  if (res.kind === "ambiguous") {
    return {
      allow: false,
      reason:
        `sddx TDD gate: ambiguous governing task — ${res.ids.join(" and ")} are both active in this workspace. ` +
        "The gate refuses to guess. Abandon or finish one, or work in each task's own worktree.",
    };
  }
  if (res.kind === "corrupt") {
    return {
      allow: false,
      reason: `sddx TDD gate: task state at ${res.path} is unreadable (${res.error}). Fix or remove it before writing — a broken state file must not silently disable the gate.`,
    };
  }

  // Pre-GREEN phases: PLAN (no failing test yet) and RED both block implementation
  // writes — "implementation-first" is exactly a write attempted before GREEN evidence.
  if (res.task.phase !== "PLAN" && res.task.phase !== "RED") return { allow: true };
  if (!input.filePath) return { allow: true }; // no target to classify (non-file event)

  const relPath = relative(res.root, anchor);
  const config = input.config ?? loadGateConfig(res.root, env);
  const cls = classify(relPath, res.task.allow, config);
  if (cls.rule !== "implementation") return { allow: true };
  return { allow: false, reason: blockMessage(res.task, relPath, config) };
}
