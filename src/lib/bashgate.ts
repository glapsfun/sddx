// RED-phase Bash allow-list: pre-GREEN, Bash may only run recognized test or
// read commands. Allow-list, not deny-list — an unlisted write path must not
// exist. Over-blocking is recoverable (userConfig red_bash_allow); a bypass is not.
import { readConfig } from "./config";
import { resolveTask } from "./resolve";
import type { TaskState } from "./task";

export const BASH_ALLOW_BASE: readonly string[] = [
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pytest",
  "go",
  "cargo",
  "make",
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "head",
  "tail",
  "wc",
];
export const GIT_READ_SUBCOMMANDS: readonly string[] = ["status", "diff", "log", "show"];

export type BashDecision = { allow: true } | { allow: false; reason: string };

const splitList = (value?: string): string[] => (value ?? "").split(/\s+/).filter((s) => s !== "");

/** Words of one pipeline segment, VAR=value env prefixes skipped. */
function commandWords(segment: string): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1;
  return words.slice(i);
}

export function checkBashCommand(command: string, extraAllow: readonly string[]): BashDecision {
  if (command.includes(">")) {
    return {
      allow: false,
      reason: "redirection (>) writes files; the gate does not parse targets",
    };
  }
  const allowed = new Set([...BASH_ALLOW_BASE, ...extraAllow]);
  for (const segment of command.split(/\|\||&&|;|\|/)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;
    const cmd = words[0] as string;
    if (cmd === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (sub === undefined || !GIT_READ_SUBCOMMANDS.includes(sub)) {
        return {
          allow: false,
          reason: `git ${sub ?? "(none)"}: only git ${GIT_READ_SUBCOMMANDS.join("|")} are allowed pre-GREEN`,
        };
      }
      continue;
    }
    if (!allowed.has(cmd)) {
      return { allow: false, reason: `"${cmd}" is not on the RED-phase Bash allow-list` };
    }
  }
  return { allow: true };
}

function blockMessage(task: TaskState, why: string): string {
  return [
    `sddx TDD gate: blocked Bash command — task ${task.id} is in ${task.phase} (${why}).`,
    `Pre-GREEN, Bash may only run tests or read state: ${BASH_ALLOW_BASE.join(", ")}, git ${GIT_READ_SUBCOMMANDS.join("|")}.`,
    "Write the failing test with Edit/Write under a test path and run the test runner so the failure is recorded (the gate lifts in GREEN).",
    "A legitimately needed read-only tool can be added via userConfig red_bash_allow.",
  ].join("\n");
}

export function bashGate(
  input: { command?: string; cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): BashDecision {
  if (typeof input.command !== "string" || input.command.trim() === "") return { allow: true };
  const res = resolveTask(input.cwd ?? process.cwd());
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
      reason: `sddx TDD gate: task state at ${res.path} is unreadable (${res.error}). Fix or remove it before running commands — a broken state file must not silently disable the gate.`,
    };
  }
  if (res.task.phase !== "PLAN" && res.task.phase !== "RED") return { allow: true };
  const extra = splitList(env.SDDX_RED_BASH_ALLOW ?? readConfig(res.root).red_bash_allow);
  const decision = checkBashCommand(input.command, extra);
  if (decision.allow) return decision;
  return { allow: false, reason: blockMessage(res.task, decision.reason) };
}
