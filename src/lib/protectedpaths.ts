// The files sddx's gates trust: `.sddx/approvals/**` (tokens recording that a
// person approved a plan), `.sddx/config.json` (the only source of
// interaction_mode and profile) and verify's proof records in
// `.git/sddx-proofs/` (what review accepts as a passed boundary proof). None may
// be written by a tool call, in any profile, task or no task: a forged token, a
// flipped mode or a forged proof would switch off the gate that constrains the
// writer. Reads stay allowed; none is a secret.
import { normalizeRelPath } from "./classify";

export const GIT_READ_SUBCOMMANDS: readonly string[] = ["status", "diff", "log", "show"];

/** Words of one pipeline segment, VAR=value env prefixes skipped. */
export function commandWords(segment: string): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1;
  return words.slice(i);
}

/** First word with surrounding quotes stripped, reduced to its basename. */
export const commandBasename = (word: string): string => {
  const bare = word.replace(/^["']+|["']+$/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
};

/**
 * The trust inputs of the approval gate, refused from Bash in EVERY phase,
 * including with no task in play at all, which is exactly the state a plan sits
 * in while it waits to be approved.
 *
 * The file-tool guard below covers Edit/Write, but that only ever covered the
 * Edit/Write tools. A shell redirect reached the
 * same files with nothing looking: the RED-phase allow-list below applies only
 * once a task resolves, so at repo root `printf … > .sddx/approvals/<hash>.json`
 * forged an approval token and the next `plan start` sailed through its gate
 * on the strength of it.
 *
 * Matching is textual, which covers `..`, doubled slashes and concatenation
 * without parsing paths. It does NOT cover shell expansion: `.sddx/approv?ls/`
 * and `${d}dx/approvals/` never spell the literal out and are NOT caught. This
 * raises the bar rather than sealing it: defense in depth behind the Edit/Write
 * guard, not a proof, and the comment says so rather than implying otherwise.
 *
 * (A previous attempt treated any glob or `$` beside `.sddx` as a reference.
 * That blocked `git add .sddx/receipts/*.json` (the framework's own persistence
 * model) while still allowing `rm -rf .sddx/worktrees/t1`, so it blocked benign
 * commands and missed destructive ones. Removed.)
 *
 * Reads are NOT blocked; see `isReadOnly` for how that is decided.
 */
export function protectedPathRef(command: string): string | null {
  if (/\bsddx-proofs\b/.test(command)) return PROOFS_DIR;
  if (!/\.sddx\b/.test(command)) return null;
  if (/\bapprovals\b/.test(command)) return ".sddx/approvals/";
  // Not preceded by a word char, `.` or `-`, so `vite.config.json` and
  // `tsconfig.json` are excluded while `/config.json` and, importantly,
  // `>config.json` still match. Anchoring on an explicit character class instead
  // dropped the redirect spelling, which is precisely the write this guards.
  if (/(^|[^\w.-])config\.json\b/.test(command)) return ".sddx/config.json";
  return null;
}

/** Commands that cannot write. Deliberately a SHORT explicit list rather than
 * the RED-phase allow-list below: that list exists to permit test runs, so it
 * includes `bun`, `node`, `python3`, `make` and `find`, every one of which can
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

export function isReadOnly(command: string): boolean {
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

/** Where `sddx verify` keeps its proof records, inside the git directory. */
const PROOFS_DIR = ".git/sddx-proofs/";
const PROOF_WHY =
  "A proof record is what review trusts as sddx verify's result, so writing one would forge a passing proof.";

export function protectedPathBlock(path: string): string {
  const why =
    path === ".sddx/config.json"
      ? "It carries interaction_mode, which decides whether a plan needs your approval at all."
      : path === PROOFS_DIR
        ? PROOF_WHY
        : "A token records that a human approved a plan, so writing one would forge that.";
  return [
    `sddx approval gate: blocked Bash command referencing ${path}.`,
    why,
    "This path is not reachable from a shell in any phase; the gate does not parse",
    "redirection targets, so it refuses the command rather than guess at intent.",
    path === ".sddx/config.json"
      ? "Inspect the effective configuration with: sddx config show"
      : path === PROOFS_DIR
        ? "Prove a task the only way that counts: sddx verify <id>"
        : "Approve a plan the only way that counts: sddx plan approve <spec>",
  ].join("\n");
}

const APPROVALS_PATH = /(^|\/)\.sddx\/approvals\//;
const CONFIG_PATH = /(^|\/)\.sddx\/config\.json$/;

const PROOFS_PATH = /(^|\/)sddx-proofs\//;

/** Why a file-tool write to `path` is refused, or null when it is not a protected file. */
export function protectedWriteBlock(path: string): string | null {
  const p = normalizeRelPath(path);
  if (PROOFS_PATH.test(p)) {
    return [
      `sddx approval gate: blocked write to ${path}; proof records are not editable.`,
      PROOF_WHY,
      "Prove a task the only way that counts: sddx verify <id>",
    ].join("\n");
  }
  if (APPROVALS_PATH.test(p)) {
    return [
      `sddx approval gate: blocked write to ${path}; approval tokens are not editable.`,
      "A token records that a person approved a plan, so writing one directly would forge that.",
      "Approve a plan the only way that counts, by a person running:",
      "  sddx plan check <spec>     # review it first",
      "  sddx plan approve <spec>",
    ].join("\n");
  }
  if (CONFIG_PATH.test(p)) {
    return [
      `sddx approval gate: blocked write to ${path}; sddx configuration is not tool-editable.`,
      "It carries interaction_mode and profile, which decide whether a plan needs your approval",
      "and how strictly edits are gated, so a tool that could rewrite it could switch off its own gate.",
      "Edit it yourself, or inspect the effective values with: sddx config show",
    ].join("\n");
  }
  return null;
}
