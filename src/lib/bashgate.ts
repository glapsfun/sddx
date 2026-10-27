// Strict profile only. Until a failing test run is recorded for the task, Bash
// may only run recognized test or read commands. Allow-list, not deny-list: an
// unlisted write path must not exist. Over-blocking is recoverable
// (red_bash_allow); a bypass is not. In the default profile this never denies.
import { profile, readConfig } from "./config";
import { commandBasename, commandWords, GIT_READ_SUBCOMMANDS } from "./protectedpaths";
import { resolutionFailureReason, resolveTask } from "./resolve";
import { mainRootOf, type TaskState } from "./task";

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

/** Interpreters that can evaluate inline code: their eval/print flags are blocked. */
const EVAL_CAPABLE: ReadonlySet<string> = new Set(["bun", "node", "npx", "python", "python3"]);
const EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print", "-c", "--exec"]);

export type BashDecision = { allow: true } | { allow: false; reason: string };

const splitList = (value?: string): string[] => (value ?? "").split(/\s+/).filter((s) => s !== "");

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
    // sddx's own CLI must always run: it is how evidence gets recorded.
    if (cmd === "sddx-run" || cmd === "sddx") continue;
    if (["bunx", "npx"].includes(cmd) && words.map(commandBasename).includes("sddx")) continue;
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
    `sddx strict gate: blocked Bash command; task ${task.id} has no recorded failing test yet (${why}).`,
    `Until then, Bash may only run tests or read state: ${BASH_ALLOW_BASE.join(", ")}, git ${GIT_READ_SUBCOMMANDS.join("|")}, and the sddx CLI itself.`,
    "Write the failing test under a test path and run the test runner so the failure is recorded; the gate lifts once it is.",
    "A legitimately needed read-only tool can be added with the red_bash_allow config key.",
  ].join("\n");
}

export function bashGate(
  input: { command?: string; cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): BashDecision {
  if (typeof input.command !== "string" || input.command.trim() === "") return { allow: true };
  const cwd = input.cwd ?? process.cwd();
  if (profile(mainRootOf(cwd)) !== "strict") return { allow: true };
  // commands the built-in list alone allows are allowed whatever the task state,
  // which keeps task resolution (a filesystem walk) off the common path
  if (checkBashCommand(input.command, []).allow) return { allow: true };
  const res = resolveTask(cwd);
  if (res.kind === "none") return { allow: true };
  const failure = resolutionFailureReason(res, "running commands");
  if (failure) return { allow: false, reason: failure };
  if (res.kind !== "task") return { allow: true };
  const t = res.task;
  if (t.phase !== "IN_PROGRESS" || t.profile !== "strict" || t.strict?.phase)
    return { allow: true };
  const extra = splitList(
    env.SDDX_RED_BASH_ALLOW ?? readConfig(mainRootOf(res.root)).red_bash_allow,
  );
  const decision = checkBashCommand(input.command, extra);
  if (decision.allow) return decision;
  return { allow: false, reason: blockMessage(t, decision.reason) };
}
