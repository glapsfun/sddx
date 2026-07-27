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
  /** READ-ONLY COMPATIBILITY. Written by versions in which an `auto` plan over a
   * blast-radius bound degraded into `human` and was approved anyway. Bounds are
   * hard refusals now, so no such hybrid exists and nothing writes these — but
   * tokens on disk still carry them and must keep parsing for audit. */
  requested_mode?: ExecutionMode;
  /** READ-ONLY COMPATIBILITY — see `requested_mode`. */
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
    workspace_mode?: string;
  },
): Approval {
  const sig = signPayload(cwd, input.plan_sha256, "sddx-approval");
  // No `requested_mode`/`degraded_reason`: an `auto` plan over a bound is
  // refused now, so a token can never describe a degraded-then-approved run.
  const approval: Approval = {
    plan_sha256: input.plan_sha256,
    mode: input.mode,
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
  /** The mode that applies. Exceeding an autonomy bound no longer turns `auto`
   * into `human` — it refuses — so this never reports a mode the caller did not
   * configure. */
  mode: ExecutionMode;
  requestedMode: ExecutionMode;
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
  // The gates users actually run are the COMPILED artifacts, not the sources:
  // hooks.json invokes `${CLAUDE_PLUGIN_ROOT}/bin/sddx-run ${CLAUDE_PLUGIN_ROOT}/dist/hooks.mjs`.
  // A plan scoped to `dist/**` rewrites the enforcement machinery just as surely
  // as one scoped to `hooks/**`, and listing only the latter left the bound
  // guarding the declaration while the implementation stayed open.
  "dist/**",
  "bin/**",
  // Where a downstream repo declares its own hooks and permissions.
  ".claude/**",
] as const;

/**
 * The DETERMINISTIC half of the autonomous blocker rule, and the half that
 * matters. The other half — an intake role reporting its own `unresolved`
 * decisions — is a model claim, and a model that assumes its way past an auth
 * change reports nothing unresolved. Everywhere else this project replaced a
 * model claim with an exit code; here it is replaced with constants that fire
 * whether or not anything self-reported a problem.
 *
 * TWO mechanisms, because one does not work. `scopesOverlap` asks "could any
 * path match both", which is right for the disjointness gate (uncertainty →
 * force an order, costing only time) and wrong here: against a doubled-star
 * pattern such as "any-depth / auth / any-depth", EVERY scope ending in a
 * doubled star overlaps, since `src/widget/...` could write
 * `src/widget/auth/x`. That refuses every realistic plan and turns auto mode
 * off rather than bounding it.
 *
 * So a scope is protected when it NAMES a protected area — a literal segment
 * below — or when it overlaps a root-anchored location. Naming catches nesting
 * at any depth (`services/api/auth/...`) without the wildcard blowup.
 *
 * Known gap, accepted deliberately: a broad scope naming nothing protected
 * (`src/**`) passes, even though it could write `src/auth/session.ts`. Closing
 * it means refusing every broad scope, which is the failure mode above. The
 * unconfined-scope bound catches the extreme case (no scope at all), and human
 * mode reviews the rest.
 *
 * Human mode does NOT consult either list — explicit approval is already
 * required there, so applying this twice would only block work under review.
 */
export const SENSITIVE_SEGMENTS = [
  "auth",
  "migrations",
  "secrets",
  "credentials",
  "billing",
] as const;

/** Root-anchored protected locations, matched by ordinary scope overlap. */
export const SENSITIVE_GLOBS = ["infra/**", "terraform/**", "k8s/**"] as const;

/** Protected FILE names, matched against a scope's last literal segment at any
 * depth. Listing these as root-anchored globs meant `services/api/Dockerfile`
 * and `services/api/.env.production` sailed past the bound while the identical
 * change at the repo root was refused — and making them any-depth globs is the
 * wildcard blowup SENSITIVE_SEGMENTS exists to avoid. */
export const SENSITIVE_FILENAMES = [/^Dockerfile/i, /^\.env/i, /^docker-compose/i] as const;

/** Does this scope glob name a protected area at any depth? Compares literal
 * segments only — a wildcard segment names nothing, which is what keeps
 * `src/**` out of this and `src/auth/**` in it. */
export function namesSensitiveArea(scope: string[]): string | undefined {
  for (const glob of scope) {
    const segments = glob.replace(/\\/g, "/").split("/");
    for (const seg of segments) {
      const s = seg.toLowerCase();
      if ((SENSITIVE_SEGMENTS as readonly string[]).includes(s)) return s;
    }
    // The last segment names a file. Wildcard-only segments (`**`, `*`) name
    // nothing, which is what keeps `src/**` out of this.
    const last = segments[segments.length - 1] ?? "";
    if (!/^[*?]+$/.test(last) && SENSITIVE_FILENAMES.some((re) => re.test(last))) return last;
  }
  return undefined;
}

/** How a refused auto plan is made actionable. Mode is config-only by design
 * (see `executionMode`), so the remedy is an edit to a reviewed file — never a
 * flag or an environment variable, both of which the agent composes itself. */
const REMEDY =
  'To review and run this plan yourself, set "execution_mode": "human" in .sddx/config.json.';

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

  // Every autonomy bound is a hard refusal, and every one is evaluated BEFORE
  // the token check. Ordering is the whole design: a token cannot buy an
  // unattended run past a bound, because writing a token is a human act and a
  // human acts in human mode. The previous ordering — bounds after the token,
  // arming the gate instead of refusing — meant `graph approve` in auto mode
  // produced a run recorded `auto` that a human had in fact approved.
  if (requestedMode === "auto") {
    const refusal = autoRefusal(nodes, ceiling, overlaps, workspaceMode);
    if (refusal) return { ...base, ok: false, mode: "auto", refusal };
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

  return { ...base, ok: true, mode: "auto" };
}

/**
 * Every bound an unattended plan must clear, in precedence order, or `undefined`
 * when it clears them all. Returning the FIRST failure keeps the message about
 * one thing a user can act on rather than a list.
 *
 * Precedence is deliberate: incoherence (a manual oracle nobody can observe)
 * before isolation, isolation before reach, reach before scale. A plan that is
 * both unconfined and over the ceiling is better described by the former.
 */
function autoRefusal(
  nodes: GateNode[],
  ceiling: number,
  overlaps: (a: string[], b: string[]) => boolean,
  workspaceMode?: string,
): string | undefined {
  // Nobody is present to observe a manual oracle. Incoherence, not risk appetite.
  const manual = nodes.find((n) => n.oracleType === "manual");
  if (manual) {
    return `node "${manual.alias}" declares oracle.type: manual — an unattended run has nobody to observe it. Use an executable oracle, or run in human mode. ${REMEDY}`;
  }

  // Isolation is a bound, not a preference. `--workspace none` runs every task
  // in the user's live checkout, mutating the branch they are sitting on —
  // unattended — and the strategy comes from the command line the agent composes.
  if (workspaceMode === "none") {
    return `workspace "none" runs every task directly in the working checkout instead of an isolated worktree, which an unattended run must not do. ${REMEDY}`;
  }

  // An EMPTY scope is unconfined — the task may write anywhere, which includes
  // both sddx's own enforcement paths and every protected path below. Treating
  // "no scope" as "no reach" would penalize honest scope declarations and make
  // omitting `scope` the cheapest bypass of both bounds.
  const unconfined = nodes.find((n) => n.scope.length === 0);
  if (unconfined) {
    return `node "${unconfined.alias}" declares no scope, so it is unconfined and may write sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")}) or protected paths (${SENSITIVE_SEGMENTS.join(", ")}, ${SENSITIVE_GLOBS.join(", ")}). ${REMEDY}`;
  }

  const selfModifying = nodes.find((n) => overlaps(n.scope, [...SELF_MODIFYING_GLOBS]));
  if (selfModifying) {
    return `node "${selfModifying.alias}" declares a scope reaching sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")}). ${REMEDY}`;
  }

  // Security, data, billing, and deployment decisions. Deterministic by design,
  // and matched two ways — see the SENSITIVE_SEGMENTS note for why one is not enough.
  for (const n of nodes) {
    const named = namesSensitiveArea(n.scope);
    if (named) {
      return `node "${n.alias}" declares a scope naming the protected area "${named}" — a security, data, billing, or deployment decision is not one an unattended run may take. ${REMEDY}`;
    }
  }
  const sensitive = nodes.find((n) => overlaps(n.scope, [...SENSITIVE_GLOBS]));
  if (sensitive) {
    return `node "${sensitive.alias}" declares a scope reaching protected paths (${SENSITIVE_GLOBS.join(", ")}) — a security, data, billing, or deployment decision is not one an unattended run may take. ${REMEDY}`;
  }

  if (nodes.length > ceiling) {
    return `plan has ${nodes.length} nodes, over the auto_max_tasks ceiling of ${ceiling}. ${REMEDY}`;
  }
  return undefined;
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
