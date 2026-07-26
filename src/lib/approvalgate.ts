// The PreToolUse half of the plan-approval gate.
//
// This is a PERMISSION gate, and it is deliberately the opposite shape from the
// prohibition gates next door (tdd-gate, bash-gate). Those deny a write and
// otherwise emit no permission decision at all — "never auto-approve, just
// don't deny" — because auto-approving would hand a tool past the user's own
// permission flow. This gate must do the thing they must not: raise the user's
// permission dialog with `permissionDecision: "ask"`.
//
// That asymmetry is the entire point. A model can type `sddx graph approve`, so
// a CLI-only gate proves only that the plan is the approved plan, never that a
// human approved it. The dialog is rendered by the user's own client and cannot
// be self-granted from inside a turn — and per the hook API, `"ask"` fires even
// when the session is in an auto-accept permission mode, so a permissive
// configuration cannot silently disable human mode.
//
// FAIL CLOSED. Every error path here resolves to "ask". A prohibition gate that
// fails open loses one assertion; a permission gate that fails open silently
// turns human mode into a no-op.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { decideGate, type GateNode, planHash } from "./approval";
import { autoMaxTasks, gateExecutionMode } from "./config";
import { scopesOverlap } from "./glob-overlap";
import { parseGraph } from "./graph";
import { parseSpec } from "./spec";

export interface ApprovalGateDecision {
  /** `ask` raises the user's permission dialog; `pass` emits no decision. */
  decision: "ask" | "pass";
  reason?: string;
}

const pass: ApprovalGateDecision = { decision: "pass" };
const ask = (reason: string): ApprovalGateDecision => ({ decision: "ask", reason });

/**
 * Splits a raw command line into individual command segments, so a compound
 * line (`a && b`, `a; b`, `a | b`) is judged per command rather than as one
 * blob. A `--dry-run` in the first segment must never vouch for a real create in
 * the second, and a `# --dry-run` comment must not vouch for anything.
 *
 * This has to be QUOTE-AWARE, not a regex split. A naive comment strip deletes
 * everything after a `#` that merely sits inside a quoted argument, so
 * `git commit -m "fix #12" && sddx graph approve …` hides the approve from the
 * gate entirely; a naive whitespace split leaves quotes glued to the token, so
 * `graph "approve"` never matches; and a raw `\n` split cuts a line
 * continuation in half, so `graph \<newline>approve` never matches either. Each
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
        if ((c === "$" && command[i + 1] === "(") || c === "`") opaque = true;
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
    if ((c === "$" && command[i + 1] === "(") || c === "`") {
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

/** Exact-token flag test — `--dry-run=false` is NOT `--dry-run`. */
const hasFlag = (tokens: string[], name: string): boolean => tokens.includes(name);

/** `--name value` or `--name=value`, quotes stripped. */
function tokenValue(tokens: string[], name: string): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === name) return tokens[i + 1]?.replace(/^["']|["']$/g, "");
    if (tokens[i].startsWith(`${name}=`)) {
      return tokens[i].slice(name.length + 1).replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

const isSubcommand = (tokens: string[], a: string, b: string): boolean => {
  const i = tokens.indexOf(a);
  return i !== -1 && tokens[i + 1] === b;
};

export type GatedAction = "create" | "approve";

/**
 * Which approval-relevant action, if any, this command segment performs.
 *
 * Both `graph create` and `graph approve` are gated. Gating `approve` is not
 * circular — it is the whole point: recording approval IS the act a human must
 * perform, so it is the command whose dialog carries the meaning. An ungated
 * `approve` lets the model write its own token and then sail through the
 * `create` gate on the strength of it, which makes human mode a no-op that
 * reports itself satisfied.
 *
 * A real `--dry-run` create writes nothing and needs no dialog; the flag is
 * matched as an exact token in the same segment as the `graph create`.
 */
export function gatedAction(command: string): GatedAction | null {
  for (const tokens of segments(command)) {
    if (isSubcommand(tokens, "graph", "approve")) return "approve";
    if (isSubcommand(tokens, "graph", "create") && !hasFlag(tokens, "--dry-run")) return "create";
  }
  return null;
}

/** Back-compat shim for callers that only ask about materialization. */
export const isPlanCreation = (command: string): boolean => gatedAction(command) === "create";

/** The nodes the blast-radius checks need, read from the plan on disk. */
function readNodes(graphPath: string): GateNode[] | null {
  if (!existsSync(graphPath)) return null;
  const { graph } = parseGraph(readFileSync(graphPath, "utf8"));
  if (!graph) return null;
  const graphDir = dirname(graphPath);
  const nodes: GateNode[] = [];
  for (const node of graph.tasks) {
    const { spec } = parseSpec(readFileSync(resolve(graphDir, node.spec), "utf8"));
    if (!spec) return null;
    nodes.push({
      alias: node.alias,
      scope: spec.scope ?? [],
      oracleType: spec.oracle.type,
    });
  }
  return nodes;
}

export function approvalGate(event: {
  command: string | undefined;
  cwd: string | undefined;
}): ApprovalGateDecision {
  const { command, cwd } = event;
  // Nothing to gate: not a command we care about. This is the one genuinely
  // safe pass-through — the gate has no opinion on `bun test`.
  if (!command || !cwd) return pass;
  try {
    const action = gatedAction(command);
    if (!action) {
      // A substitution can expand into `sddx graph approve` that the lexer never
      // sees, so "no gated action found" is not a safe conclusion for a line it
      // could not fully read. Scoped to lines that name sddx at all, so an
      // unrelated `echo $(date)` still passes — see the FAIL CLOSED note above.
      if (lex(command).opaque && /\bsddx\b/.test(command)) {
        return ask(
          [
            "sddx: this command names sddx and uses substitution the approval gate cannot read.",
            "What it expands to cannot be verified, so it cannot be vouched for.",
          ].join("\n"),
        );
      }
      return pass;
    }

    // Find the segment that performs the action, so `--graph`/`--workspace` are
    // read from the right command in a compound line.
    const tokens =
      segments(command).find((t) =>
        action === "approve"
          ? isSubcommand(t, "graph", "approve")
          : isSubcommand(t, "graph", "create") && !hasFlag(t, "--dry-run"),
      ) ?? [];
    const graphArg = tokenValue(tokens, "--graph");

    // Recording approval is the human act this whole mechanism exists to
    // capture, so it ALWAYS raises the dialog — there is no mode and no token
    // that can pre-satisfy it. This is what stops the model granting itself
    // approval and then walking through the create gate on its own token.
    if (action === "approve") {
      const plan = graphArg
        ? planHash(isAbsolute(graphArg) ? graphArg : join(cwd, graphArg))
        : null;
      return ask(
        [
          `sddx: this records YOUR approval of plan ${plan?.hash ? plan.hash.slice(0, 12) : "(unreadable)"}.`,
          "Approve only if you have reviewed it:",
          `  sddx graph create --graph ${graphArg ?? "<path>"} --dry-run`,
        ].join("\n"),
      );
    }

    if (!graphArg) {
      return ask("sddx: plan creation without a --graph argument — cannot verify what would run");
    }
    const graphPath = isAbsolute(graphArg) ? graphArg : join(cwd, graphArg);

    const nodes = readNodes(graphPath);
    if (!nodes) {
      return ask(`sddx: plan at ${graphArg} could not be read — approval cannot be verified`);
    }

    // Mode comes from `.sddx/config.json` ONLY. It is deliberately NOT read from
    // the command line or the environment here: both are composed by the very
    // agent this gate constrains, so honoring a `--mode auto` or an inline
    // `SDDX_EXECUTION_MODE=auto` would let it switch off the user's chosen mode.
    const gate = decideGate(
      cwd,
      graphPath,
      nodes,
      gateExecutionMode(cwd),
      autoMaxTasks(cwd),
      scopesOverlap,
      // omitted deliberately: only the CLI can resolve `auto` to the effective
      // strategy (it needs git), and the CLI predicate enforces the match.
    );
    if (gate.ok) return pass;
    // A hard refusal is the CLI's to report — it must fail, not ask, and the
    // command itself will exit non-zero with the reason. Let it through to say so.
    if (gate.refusal) return pass;

    const scale = `${gate.nodeCount} node${gate.nodeCount === 1 ? "" : "s"}`;
    return ask(
      [
        `sddx: this creates ${scale} of work from plan ${gate.hash.slice(0, 12)}.`,
        gate.reason ?? "approval required",
        `Review it first: sddx graph create --graph ${graphArg} --dry-run`,
      ].join("\n"),
    );
  } catch (e) {
    // fail closed — see the header note
    return ask(`sddx: approval could not be verified (${(e as Error).message}) — asking instead`);
  }
}
