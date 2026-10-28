// The PreToolUse half of the plan-approval gate.
//
// This is a PERMISSION gate, and it is deliberately the opposite shape from the
// prohibition gates next door (tdd-gate, bash-gate). Those deny a write and
// otherwise emit no permission decision at all — "never auto-approve, just
// don't deny" — because auto-approving would hand a tool past the user's own
// permission flow. This gate must do the thing they must not: raise the user's
// permission dialog with `permissionDecision: "ask"`.
//
// That asymmetry is the entire point. A model can type `sddx plan approve`, so
// a CLI-only gate proves only that the plan is the approved plan, never that a
// human approved it. The dialog is rendered by the user's own client and cannot
// be self-granted from inside a turn — and per the hook API, `"ask"` fires even
// when the session is in an auto-accept permission mode, so a permissive
// configuration cannot silently disable human mode.
//
// FAIL CLOSED. Every error path here resolves to "ask". A prohibition gate that
// fails open loses one assertion; a permission gate that fails open silently
// turns human mode into a no-op.

//
// It also owns the two files the gate trusts: a write to `.sddx/approvals/**` or
// `.sddx/config.json`, by a file tool or a shell command, is denied in every
// profile, task or no task (see protectedpaths.ts).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { decideGate, type GateNode, planHash } from "./approval";
import { autoMaxTasks, gateInteractionMode } from "./config";
import { scopesOverlap } from "./glob-overlap";
import { parseGoalSpec } from "./goalspec";
import { leadingPatchHeredoc, patchTargets } from "./patch";
import {
  isReadOnly,
  protectedPathBlock,
  protectedPathRef,
  protectedWriteBlock,
} from "./protectedpaths";

export interface ApprovalGateDecision {
  /** `ask` raises the user's permission dialog; `deny` refuses; `pass` emits no decision. */
  decision: "ask" | "deny" | "pass";
  reason?: string;
  /** For an `ask` about a plan: the spec argument, so a harness without a dialog
   * can hand the approve command to the user. */
  spec?: string;
}

const pass: ApprovalGateDecision = { decision: "pass" };
const ask = (reason: string, spec?: string): ApprovalGateDecision =>
  spec === undefined ? { decision: "ask", reason } : { decision: "ask", reason, spec };
const deny = (reason: string): ApprovalGateDecision => ({ decision: "deny", reason });

/** The first protected path a patch writes from any of `dirs`, as a file-tool write would be judged. */
function patchBlock(patch: string, dirs: string[]): string | null {
  for (const target of patchTargets(patch)) {
    for (const path of [target, ...dirs.map((d) => resolve(d, target))]) {
      const blocked = protectedWriteBlock(path);
      if (blocked) return blocked;
    }
  }
  return null;
}

/**
 * Splits a raw command line into individual command segments, so a compound
 * line (`a && b`, `a; b`, `a | b`) is judged per command rather than as one
 * blob. A `--dry-run` in the first segment must never vouch for a real create in
 * the second, and a `# --dry-run` comment must not vouch for anything.
 *
 * This has to be QUOTE-AWARE, not a regex split. A naive comment strip deletes
 * everything after a `#` that merely sits inside a quoted argument, so
 * `git commit -m "fix #12" && sddx plan approve …` hides the approve from the
 * gate entirely; a naive whitespace split leaves quotes glued to the token, so
 * `plan "approve"` never matches; and a raw `\n` split cuts a line
 * continuation in half, so `plan \<newline>approve` never matches either. Each
 * of those is a silent bypass of the human dialog, so the lexer tracks quoting,
 * escapes, and continuations the way the shell that will actually run the line
 * does.
 *
 * `opaque` reports that the line contains command/process substitution, whose
 * expansion this cannot see. Callers must treat an opaque line as unverifiable
 * rather than as "no gated action found" — same stance `bashgate` takes when it
 * refuses to parse a substitution.
 */
export function lex(command: string): { segments: string[][]; opaque: boolean } {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let started = false; // cur holds a token, even an empty quoted one
  let quote: '"' | "'" | null = null;
  let opaque = false;

  const endToken = (): void => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;

    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\" && i + 1 < command.length) {
        i += 1;
        cur += command[i] as string;
      } else {
        // ANY unescaped `$` outside single quotes: `$(…)`, `$VAR`, `${VAR}`,
        // `$'…'` and `$((…))` are all expansions whose result this cannot see.
        if (c === "$" || c === "`") opaque = true;
        cur += c;
      }
      started = true;
      continue;
    }

    if (c === "\\") {
      // line continuation: the shell splices it out, so neither a segment break
      // nor a token break happens here
      if (command[i + 1] === "\n") {
        i += 1;
        continue;
      }
      if (i + 1 < command.length) {
        i += 1;
        cur += command[i] as string;
        started = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      started = true;
      continue;
    }
    // `#` opens a comment only at a word boundary — `fix#12` is a literal
    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i += 1;
      continue;
    }
    if (c === "$" || c === "`") {
      opaque = true;
      cur += c;
      started = true;
      continue;
    }
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
      endSegment();
      i += 1;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      endSegment();
      continue;
    }
    if (/\s/.test(c)) {
      endToken();
      continue;
    }
    cur += c;
    started = true;
  }

  // an unterminated quote means the parse does not describe what will run
  if (quote !== null) opaque = true;
  endSegment();
  return { segments, opaque };
}

const segments = (command: string): string[][] => lex(command).segments;

/**
 * `a` followed by `b`, tolerating global flags in between. `parseOutputFlag`
 * strips `--output <v>` and `--no-color` from ANY position before dispatch, so
 * `sddx plan --output json approve` really does run `plan approve`; matching
 * only the immediately-next token let that ordering through the gate.
 */
/**
 * Does this token invoke sddx? `plan` is a common word, so only an sddx
 * invocation's `plan approve` is gated, and this test must err wide: a miss is
 * an approval with no dialog. Any token naming sddx counts (`sddx`,
 * `@glapsfun/sddx@6.0.0`, `sddx@latest`, `/opt/sddx-6/bin/run`), plus the
 * bundle's entry points run directly (`node dist/cli.mjs`, `bun src/cli.ts`).
 */
const invokesSddx = (token: string): boolean =>
  /sddx/i.test(token) || /^cli\.(mjs|ts)$/.test(token.slice(token.lastIndexOf("/") + 1));

const isSubcommand = (tokens: string[], a: string, b: string): boolean => {
  const i = tokens.indexOf(a);
  if (i === -1) return false;
  if (!tokens.slice(0, i).some(invokesSddx)) return false;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j] as string;
    if (t === b) return true;
    if (!t.startsWith("-")) return false; // a different subcommand — stop
    if (t === "--output") j += 1; // takes a value
  }
  return false;
};

export type GatedAction = "start" | "approve";

/**
 * Which approval-relevant action, if any, this command line performs. Both are
 * gated. Gating `approve` is not circular, it is the point: recording approval
 * IS the act a person must perform, so it is the command whose dialog carries
 * the meaning. An ungated `approve` would let the model write its own token and
 * then walk through the `start` gate on the strength of it.
 */
/** Commands that run their argument as a command line of its own, hiding it
 * inside a single quoted token: `sh -c '…'`, `eval '…'`, `xargs …`. Quote-aware
 * lexing is what makes that token whole, so without unwrapping them the
 * subcommand disappears from the gate's view entirely.
 *
 * Recursion is limited to THESE, not to every token containing whitespace.
 * Unwrapping indiscriminately made `git commit -m "run sddx plan approve
 * first"` raise an approval dialog — and a dialog that fires on a commit message
 * trains the user to click through the one prompt this whole design rests on.
 * False alarms are a real cost here, not merely a nuisance. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "eval",
  "xargs",
  "env",
  "nohup",
  "timeout",
  "nice",
  "command",
  "exec",
]);

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** Every command line this one contains: its own segments, plus those carried
 * inside a wrapper's argument, to `depth` levels. */
function allSegments(command: string, depth = 0): string[][] {
  const segs = segments(command);
  if (depth >= 3) return segs;
  const out = [...segs];
  for (const tokens of segs) {
    const head = tokens[0];
    if (!head || !WRAPPERS.has(basename(head))) continue;
    for (const token of tokens.slice(1)) {
      if (/\s/.test(token)) out.push(...allSegments(token, depth + 1));
    }
  }
  return out;
}

export function gatedAction(command: string): GatedAction | null {
  const segs = allSegments(command);
  // `approve` is checked across ALL segments before `start` across any of them,
  // so `plan start <a> && plan approve <b>` cannot report itself as a start.
  if (segs.some((t) => isSubcommand(t, "plan", "approve"))) return "approve";
  if (segs.some((t) => isSubcommand(t, "plan", "start"))) return "start";
  return null;
}

const VALUE_FLAGS = new Set(["--output", "--harness"]);

/** The first positional argument after subcommand `b`: the spec path. */
function specArgOf(tokens: string[], b: string): string | undefined {
  const i = tokens.indexOf(b);
  if (i === -1) return undefined;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j] as string;
    if (VALUE_FLAGS.has(t)) {
      j += 1;
      continue;
    }
    if (!t.startsWith("-")) return t;
  }
  return undefined;
}

function readPlan(specPath: string): { nodes: GateNode[]; openDecisions: string[] } | null {
  if (!existsSync(specPath)) return null;
  const { spec } = parseGoalSpec(readFileSync(specPath, "utf8"));
  if (!spec) return null;
  return {
    nodes: spec.tasks.map((t) => ({ alias: t.id, scope: t.scope, oracleType: t.oracle.type })),
    openDecisions: spec.design.openDecisions,
  };
}

export function approvalGate(event: {
  command?: string;
  filePath?: string;
  /** The text of a Codex `apply_patch` call. */
  patch?: string;
  cwd?: string;
}): ApprovalGateDecision {
  const { filePath } = event;
  let command = event.command;
  const cwd = event.cwd ?? process.cwd();
  if (filePath !== undefined) {
    // `resolve` normalizes: `.sddx/tasks/../approvals/x.json` reaches the
    // approvals directory while spelling none of it
    const blocked = protectedWriteBlock(filePath) ?? protectedWriteBlock(resolve(cwd, filePath));
    return blocked ? deny(blocked) : pass;
  }
  if (event.patch !== undefined) {
    const blocked = patchBlock(event.patch, [cwd]);
    return blocked ? deny(blocked) : pass;
  }
  if (!command) return pass;
  try {
    // A patch fed to apply_patch through the shell is judged by the files it
    // writes; only the shell text around it is read as commands.
    const heredoc = leadingPatchHeredoc(command, cwd);
    if (heredoc) {
      const blocked = patchBlock(heredoc.patch, heredoc.dirs);
      if (blocked) return deny(blocked);
      command = heredoc.shell;
    }
    const protectedPath = protectedPathRef(command);
    if (protectedPath && !isReadOnly(command)) return deny(protectedPathBlock(protectedPath));

    const parsed = lex(command);
    const action = gatedAction(command);
    if (!action) {
      // An expansion can produce `sddx plan approve` that the lexer never sees,
      // so "no gated action found" is not a safe conclusion for a line it could
      // not fully read. Scoped to lines naming both sddx and plan, so ordinary
      // commands that merely use a variable do not raise dialogs.
      if (parsed.opaque && /\bsddx\b/.test(command) && /\bplan\b/.test(command)) {
        return ask(
          [
            "sddx: this command names sddx and uses an expansion the approval gate cannot read.",
            "What it expands to cannot be verified, so it cannot be vouched for.",
          ].join("\n"),
        );
      }
      return pass;
    }

    const tokens = allSegments(command).find((t) => isSubcommand(t, "plan", action)) ?? [];
    const specArg = specArgOf(tokens, action);
    const specPath = specArg ? (isAbsolute(specArg) ? specArg : join(cwd, specArg)) : null;

    // Recording approval always raises the dialog: no mode and no token can
    // pre-satisfy the act of approving.
    if (action === "approve") {
      const plan = specPath ? planHash(specPath) : null;
      return ask(
        [
          `sddx: this records YOUR approval of plan ${plan?.hash ? plan.hash.slice(0, 12) : "(unreadable)"}.`,
          "Approve only if you have reviewed it:",
          `  sddx plan check ${specArg ?? "<spec>"}`,
        ].join("\n"),
        specArg,
      );
    }

    if (!specPath)
      return ask("sddx: plan start without a spec argument; cannot verify what would run");
    const plan = readPlan(specPath);
    if (!plan)
      return ask(
        `sddx: plan at ${specArg} could not be read; approval cannot be verified`,
        specArg,
      );

    // Mode comes from `.sddx/config.json` only, never from the command line or
    // the environment, both of which the constrained agent composes.
    const gate = decideGate(
      cwd,
      specPath,
      plan.nodes,
      gateInteractionMode(cwd),
      autoMaxTasks(cwd),
      scopesOverlap,
      plan.openDecisions,
    );
    if (gate.ok) return pass;
    // A hard refusal is the CLI's to report: it must fail, not ask.
    if (gate.refusal) return pass;
    const scale = `${gate.nodeCount} task${gate.nodeCount === 1 ? "" : "s"}`;
    return ask(
      [
        `sddx: this starts ${scale} of work from plan ${gate.hash.slice(0, 12)}.`,
        gate.reason ?? "approval required",
        `Review it first: sddx plan check ${specArg}`,
      ].join("\n"),
      specArg,
    );
  } catch (e) {
    return ask(`sddx: approval could not be verified (${(e as Error).message}); asking instead`);
  }
}
