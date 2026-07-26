// Plan approval: the deterministic gate between a draft plan (no side effects)
// and a materialized one (run branch, worktrees, task files). Approval is
// content-addressed over `plan_sha256` — the hash of the graph plus every spec
// it references — so a plan edited after approval no longer matches its token
// and approve-A-execute-B is impossible rather than merely discouraged.
//
// What this proves and what it does not: a matching token proves the plan that
// runs is the plan that was approved. It does NOT prove a human approved it —
// any caller can write a token. The hook-side permission dialog is what a model
// cannot self-grant, and an SSH signature over a touch-required key is the only
// configuration that binds approval to a person. See docs/execution-modes.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecutionMode } from "./config";
import { parseGraph } from "./graph";
import { sha256 } from "./receipt";
import { signPayload } from "./sign";
import { sddxDir } from "./task";

export interface Approval {
  plan_sha256: string;
  /** The mode the plan was approved to run under. */
  mode: ExecutionMode;
  /** Set only when `auto` was requested but a blast-radius bound armed the gate. */
  requested_mode?: ExecutionMode;
  /** The bound that forced the degradation, when one did. */
  degraded_reason?: string;
  at: string;
  /** The `--workspace` strategy this plan was approved under. A token does not
   * vouch for a different one — swapping `worktree` for `none` moves every task
   * into the user's live checkout. Absent on tokens written before this existed. */
  workspace_mode?: string;
  /** Optional SSH signature over `plan_sha256`, namespace `sddx-approval`. */
  signature?: string;
  signer?: string;
  /** Reserved: per-node spec revisions approved after the plan itself.
   * Always empty in this version — see the amendments design note. */
  amendments: never[];
}

export const approvalsDir = (cwd: string): string => join(sddxDir(cwd), "approvals");
export const approvalPath = (cwd: string, hash: string): string =>
  join(approvalsDir(cwd), `${hash}.json`);

export interface PlanHash {
  hash: string;
  /** Absolute paths hashed, in the canonical order used — graph first, then
   * specs by alias. Useful for reporting what a hash actually covered. */
  files: string[];
  errors: string[];
}

/**
 * sha256 over the graph file's bytes plus every referenced spec's bytes, in a
 * canonical order (graph first, then specs sorted by node alias). Ordering is
 * derived from the parsed aliases rather than from directory enumeration, so
 * the hash cannot move with filesystem ordering or with the order nodes happen
 * to be declared in.
 *
 * Any unreadable input yields `hash: ""` plus errors — an unhashable plan must
 * never silently hash to something, since that something could match a token.
 */
export function planHash(graphPath: string): PlanHash {
  const files: string[] = [];
  if (!existsSync(graphPath)) {
    return { hash: "", files, errors: [`plan: ${graphPath} not found`] };
  }
  let graphText: string;
  try {
    graphText = readFileSync(graphPath, "utf8");
  } catch (e) {
    return { hash: "", files, errors: [`plan: ${graphPath} unreadable: ${(e as Error).message}`] };
  }
  const { graph, errors } = parseGraph(graphText);
  if (!graph) return { hash: "", files, errors };

  const graphDir = dirname(graphPath);
  const parts: string[] = [`graph\0${sha256(graphText)}`];
  files.push(graphPath);

  // canonical: by alias, never by declaration or directory order
  const nodes = [...graph.tasks].sort((a, b) =>
    a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0,
  );
  const specErrors: string[] = [];
  for (const node of nodes) {
    const specPath = resolve(graphDir, node.spec);
    try {
      parts.push(`spec\0${node.alias}\0${sha256(readFileSync(specPath, "utf8"))}`);
      files.push(specPath);
    } catch {
      specErrors.push(`plan: node "${node.alias}" spec ${node.spec} is missing or unreadable`);
    }
  }
  if (specErrors.length > 0) return { hash: "", files, errors: specErrors };
  return { hash: sha256(parts.join("\n")), files, errors: [] };
}

/** Writes the token for `plan_sha256`, signing best-effort. An unconfigured or
 * failing key yields an unsigned token — never an error, matching how receipt
 * signing already behaves. */
export function writeApproval(
  cwd: string,
  input: {
    plan_sha256: string;
    mode: ExecutionMode;
    requested_mode?: ExecutionMode;
    degraded_reason?: string;
    workspace_mode?: string;
  },
): Approval {
  const sig = signPayload(cwd, input.plan_sha256, "sddx-approval");
  const approval: Approval = {
    plan_sha256: input.plan_sha256,
    mode: input.mode,
    ...(input.requested_mode ? { requested_mode: input.requested_mode } : {}),
    ...(input.degraded_reason ? { degraded_reason: input.degraded_reason } : {}),
    ...(input.workspace_mode ? { workspace_mode: input.workspace_mode } : {}),
    at: new Date().toISOString(),
    ...(sig ? { signature: sig.signature, signer: sig.signer } : {}),
    amendments: [],
  };
  mkdirSync(approvalsDir(cwd), { recursive: true });
  writeFileSync(approvalPath(cwd, input.plan_sha256), `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

/** Reads the token for `hash`, or null when absent, unreadable, or when its
 * recorded hash disagrees with the name it is filed under. Every failure mode
 * collapses to "no approval" — a token that cannot be trusted is not one. */
export function readApproval(cwd: string, hash: string): Approval | null {
  const path = approvalPath(cwd, hash);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const a = parsed as Approval;
    if (a.plan_sha256 !== hash) return null;
    return a;
  } catch {
    return null;
  }
}

export interface ApprovalLookup {
  ok: boolean;
  hash: string;
  approval?: Approval;
  reason?: string;
}

/** Resolves whether `graphPath` is approved as it currently stands on disk. */
export function findApproval(cwd: string, graphPath: string): ApprovalLookup {
  const { hash, errors } = planHash(graphPath);
  if (hash === "") return { ok: false, hash: "", reason: errors.join("; ") };
  const approval = readApproval(cwd, hash);
  if (!approval) {
    return {
      ok: false,
      hash,
      reason: `no approval on file for plan ${hash.slice(0, 12)} — approve it with: sddx graph approve --graph <path>`,
    };
  }
  return { ok: true, hash, approval };
}

/**
 * Goal-level assumptions denormalized into one node's list. A receipt that
 * needs a second file to be interpreted stops being a receipt, so cross-cutting
 * assumptions are copied into every spec at plan-creation time rather than
 * resolved through the goal at read time. Goal assumptions come first; a node
 * repeating one does not duplicate it.
 */
export function mergeAssumptions(goalLevel: string[], nodeLevel: string[]): string[] {
  const out: string[] = [];
  for (const a of [...goalLevel, ...nodeLevel]) if (!out.includes(a)) out.push(a);
  return out;
}

/** One node as the blast-radius checks see it. */
export interface GateNode {
  alias: string;
  scope: string[];
  oracleType: string;
}

export interface GateDecision {
  /** True when creation may proceed without asking a human. */
  ok: boolean;
  hash: string;
  /** The mode that will actually apply. `auto` degrades to `human` when a
   * blast-radius bound is exceeded — never a separate code path, just the gate
   * arming as it always would. */
  mode: ExecutionMode;
  requestedMode: ExecutionMode;
  /** Set when `auto` degraded; names the bound that forced it. */
  degradedReason?: string;
  /** Why approval is still required, when `ok` is false. */
  reason?: string;
  /** A hard refusal — not a gate arming. Creation must fail, not ask. */
  refusal?: string;
  nodeCount: number;
}

/** Scope globs that reach the machinery enforcing sddx's own gates. A plan that
 * edits the thing enforcing the plan always meets a human, in either mode. */
export const SELF_MODIFYING_GLOBS = [
  "hooks/**",
  ".claude-plugin/**",
  ".github/workflows/**",
] as const;

/**
 * The single approval decision, shared by the CLI predicate and the PreToolUse
 * hook so the two can never disagree about whether a plan needs a human.
 *
 * Order matters: hard refusals first (they must fail, not ask — asking a human
 * to approve an incoherent plan is worse than refusing it), then the token
 * check, then the `auto` blast-radius bounds.
 */
export function decideGate(
  cwd: string,
  graphPath: string,
  nodes: GateNode[],
  requestedMode: ExecutionMode,
  ceiling: number,
  overlaps: (a: string[], b: string[]) => boolean,
  /** The RESOLVED effective workspace strategy (downgrades applied), not the raw
   * `--workspace` flag — the token records a resolved value, so comparing a flag
   * against it would mismatch on every `auto`. Omit to skip the check: the hook
   * cannot resolve it without git, and the CLI predicate enforces it either way.
   */
  workspaceMode?: string,
): GateDecision {
  const { hash, errors } = planHash(graphPath);
  const base = { hash, requestedMode, nodeCount: nodes.length };
  if (hash === "") {
    return { ...base, ok: false, mode: "human", reason: errors.join("; ") || "plan unreadable" };
  }

  if (requestedMode === "auto") {
    // Hard refusal: nobody is present to observe a manual oracle. This is
    // incoherence, not risk appetite, so it fails rather than arming the gate.
    const manual = nodes.find((n) => n.oracleType === "manual");
    if (manual) {
      return {
        ...base,
        ok: false,
        mode: "auto",
        refusal: `node "${manual.alias}" declares oracle.type: manual — an unattended run has nobody to observe it. Use an executable oracle, or run in human mode.`,
      };
    }
  }

  const approval = readApproval(cwd, hash);
  if (approval) {
    // A token vouches for the plan AND the workspace strategy it was rendered
    // under. `--workspace none` runs every task in the user's live checkout
    // instead of an isolated worktree — approving a `worktree` render must not
    // silently authorize that.
    if (
      workspaceMode !== undefined &&
      approval.workspace_mode !== undefined &&
      approval.workspace_mode !== workspaceMode
    ) {
      return {
        ...base,
        ok: false,
        mode: "human",
        reason: `plan ${hash.slice(0, 12)} was approved for workspace "${approval.workspace_mode}", not "${workspaceMode}" — re-render and re-approve to change the workspace strategy`,
      };
    }
    return { ...base, ok: true, mode: approval.mode, hash };
  }

  if (requestedMode === "human") {
    return {
      ...base,
      ok: false,
      mode: "human",
      reason: `no approval on file for plan ${hash.slice(0, 12)} — review it with: sddx graph create --graph <path> --dry-run, then approve with: sddx graph approve --graph <path>`,
    };
  }

  // auto: within bounds it self-approves; over them the gate arms exactly as it
  // would in human mode. Degradation is recorded, never silent.
  const overCeiling = nodes.length > ceiling;
  // An EMPTY scope is unconfined — the task may write anywhere, which includes
  // sddx's own enforcement paths. Treating "no scope" as "no reach" would have
  // penalized honest scope declarations and made omitting `scope` a bypass, so
  // an unconfined node trips this bound exactly as an explicitly-reaching one does.
  const selfModifying = nodes.find(
    (n) => n.scope.length === 0 || overlaps(n.scope, [...SELF_MODIFYING_GLOBS]),
  );
  if (selfModifying) {
    const why =
      selfModifying.scope.length === 0
        ? `node "${selfModifying.alias}" declares no scope, so it is unconfined and may write sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")})`
        : `node "${selfModifying.alias}" declares a scope reaching sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")})`;
    return {
      ...base,
      ok: false,
      mode: "human",
      degradedReason: why,
      reason: `auto mode degraded to human: ${why}`,
    };
  }
  if (overCeiling) {
    return {
      ...base,
      ok: false,
      mode: "human",
      degradedReason: `plan has ${nodes.length} nodes, over the auto_max_tasks ceiling of ${ceiling}`,
      reason: `auto mode degraded to human: ${nodes.length} nodes exceeds auto_max_tasks=${ceiling}`,
    };
  }
  return { ...base, ok: true, mode: "auto" };
}

/** Every approval token on disk, newest first. Used by the audit to check
 * signatures without needing the drafts that produced them. */
export function listApprovals(cwd: string): Approval[] {
  const dir = approvalsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: Approval[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const a = readApproval(cwd, f.slice(0, -".json".length));
    if (a) out.push(a);
  }
  return out.sort((x, y) => (x.at < y.at ? 1 : -1));
}
