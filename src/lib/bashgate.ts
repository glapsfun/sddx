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

/**
 * The trust inputs of the approval gate, refused from Bash in EVERY phase —
 * including with no task in play at all, which is exactly the state a plan sits
 * in while it waits to be approved.
 *
 * tdd-gate blocks Edit/Write to `.sddx/approvals/**` and `.sddx/config.json`,
 * but that only ever covered the Edit/Write tools. A shell redirect reached the
 * same files with nothing looking: the RED-phase allow-list below applies only
 * once a task resolves, so at repo root `printf … > .sddx/approvals/<hash>.json`
 * forged an approval token and the next `graph create` sailed through its gate
 * on the strength of it.
 *
 * Matching is textual, which covers `..`, doubled slashes and concatenation
 * without parsing paths. It does NOT cover shell expansion: `.sddx/approv?ls/`
 * and `${d}dx/approvals/` never spell the literal out and are NOT caught. This
 * raises the bar rather than sealing it — defense in depth behind the Edit/Write
 * guard, not a proof, and the comment says so rather than implying otherwise.
 *
 * (A previous attempt treated any glob or `$` beside `.sddx` as a reference.
 * That blocked `git add .sddx/receipts/*.json` — the framework's own persistence
 * model — while still allowing `rm -rf .sddx/worktrees/t1`, so it blocked benign
 * commands and missed destructive ones. Removed.)
 *
 * Reads are NOT blocked; see `isReadOnly` for how that is decided.
 */
function protectedPathRef(command: string): string | null {
  if (!/\.sddx\b/.test(command)) return null;
  if (/\bapprovals\b/.test(command)) return ".sddx/approvals/";
  // Not preceded by a word char, `.` or `-`, so `vite.config.json` and
  // `tsconfig.json` are excluded while `/config.json` and — importantly —
  // `>config.json` still match. Anchoring on an explicit character class instead
  // dropped the redirect spelling, which is precisely the write this guards.
  if (/(^|[^\w.-])config\.json\b/.test(command)) return ".sddx/config.json";
  return null;
}

/** Commands that cannot write. Deliberately a SHORT explicit list rather than
 * the RED-phase allow-list below: that list exists to permit test runs, so it
 * includes `bun`, `node`, `python3`, `make` and `find` — every one of which can
 * write a file without a redirect (`find … -delete`, `find … -exec cp …`,
 * `bun run forge.ts`). Using it as a read-only proxy reopened the forge path it
 * was supposed to close. */
const READ_ONLY: ReadonlySet<string> = new Set([
  "cat",
  "grep",
  "rg",
  "ls",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "diff",
  "echo",
]);

function isReadOnly(command: string): boolean {
  // any redirection or substitution and this is not a read, whatever the command
  if (/\$\(|`|<\(/.test(command)) return false;
  if (command.replace(/\d*>&\d+/g, "").includes(">")) return false;
  for (const segment of command.split(/\|\||&&|;|\||\r?\n/)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;
    const cmd = commandBasename(words[0] as string);
    if (cmd === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (sub === undefined || !GIT_READ_SUBCOMMANDS.includes(sub)) return false;
      continue;
    }
    if (!READ_ONLY.has(cmd)) return false;
  }
  return true;
}

function protectedPathBlock(path: string): string {
  const why =
    path === ".sddx/config.json"
      ? "It carries interaction_mode, which decides whether a plan needs your approval at all."
      : "A token records that a human approved a plan, so writing one would forge that.";
  return [
    `sddx approval gate: blocked Bash command referencing ${path}.`,
    why,
    "This path is not reachable from a shell in any phase — the gate does not parse",
    "redirection targets, so it refuses the command rather than guess at intent.",
    path === ".sddx/config.json"
      ? "Inspect the effective configuration with: sddx config show"
      : "Approve a plan the only way that counts: sddx graph approve --graph <path>",
  ].join("\n");
}

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
  // Before everything else, including task resolution: this holds with no task
  // in play, which is when a plan is awaiting approval. Only a reference that is
  // not a plain read is refused — an approval token is not a secret, and this
  // repo's own source and tests name these paths constantly.
  const protectedPath = protectedPathRef(input.command);
  if (protectedPath && !isReadOnly(input.command)) {
    return { allow: false, reason: protectedPathBlock(protectedPath) };
  }
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
