// RED-phase Bash allow-list: pre-GREEN, Bash may only run recognized test or
// read commands. Allow-list, not deny-list — an unlisted write path must not
// exist. Over-blocking is recoverable (userConfig red_bash_allow); a bypass is not.
import { readConfig } from "./config";
import { resolutionFailureReason, resolveTask } from "./resolve";
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
  "node",
  "python",
  "python3",
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

/** Interpreters that can evaluate inline code: their eval/print flags are blocked. */
const EVAL_CAPABLE: ReadonlySet<string> = new Set(["bun", "node", "npx", "python", "python3"]);
const EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print", "-c", "--exec"]);

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

/** First word with surrounding quotes stripped, reduced to its basename. */
const commandBasename = (word: string): string => {
  const bare = word.replace(/^["']+|["']+$/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
};

export function checkBashCommand(command: string, extraAllow: readonly string[]): BashDecision {
  if (/\$\(|`|<\(/.test(command)) {
    return {
      allow: false,
      reason:
        "command/process substitution executes arbitrary commands; the gate does not parse it",
    };
  }
  // fd duplication (2>&1, >&2) writes no files — strip it before the redirection test
  if (command.replace(/\d*>&\d+/g, "").includes(">")) {
    return {
      allow: false,
      reason: "redirection (>) writes files; the gate does not parse targets",
    };
  }
  const allowed = new Set([...BASH_ALLOW_BASE, ...extraAllow]);
  for (const segment of command.split(/\|\||&&|;|\||\r?\n/)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;
    const cmd = commandBasename(words[0] as string);
    // the plugin's own CLI must run in every phase — it is how phases get recorded
    if (cmd === "sddx-run" || cmd === "sddx") continue;
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
    if (EVAL_CAPABLE.has(cmd) && words.some((w) => EVAL_FLAGS.has(w))) {
      return {
        allow: false,
        reason: `${cmd} with an eval/print flag can write files from inline code`,
      };
    }
  }
  return { allow: true };
}

function blockMessage(task: TaskState, why: string): string {
  return [
    `sddx TDD gate: blocked Bash command — task ${task.id} is in ${task.phase} (${why}).`,
    `Pre-GREEN, Bash may only run tests or read state: ${BASH_ALLOW_BASE.join(", ")}, git ${GIT_READ_SUBCOMMANDS.join("|")}, and the sddx CLI itself.`,
    "Write the failing test with Edit/Write under a test path and run the test runner so the failure is recorded (the gate lifts in GREEN).",
    "A legitimately needed read-only tool can be added via userConfig red_bash_allow.",
  ].join("\n");
}

export function bashGate(
  input: { command?: string; cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): BashDecision {
  if (typeof input.command !== "string" || input.command.trim() === "") return { allow: true };
  // fast path: commands allowed by the built-in list alone are allowed in every
  // phase — skip task resolution (fs walk) for the common case
  if (checkBashCommand(input.command, []).allow) return { allow: true };
  const res = resolveTask(input.cwd ?? process.cwd());
  if (res.kind === "none") return { allow: true };
  const failure = resolutionFailureReason(res, "running commands");
  if (failure) return { allow: false, reason: failure };
  if (res.kind !== "task") return { allow: true };
  if (res.task.phase !== "PLAN" && res.task.phase !== "RED") return { allow: true };
  const extra = splitList(env.SDDX_RED_BASH_ALLOW ?? readConfig(res.root).red_bash_allow);
  const decision = checkBashCommand(input.command, extra);
  if (decision.allow) return decision;
  return { allow: false, reason: blockMessage(res.task, decision.reason) };
}
