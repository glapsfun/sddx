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
// configuration that binds approval to a person. See
// docs/explanation/interaction-modes.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InteractionMode } from "./config";
import { parseGraph } from "./graph";
import { sha256 } from "./receipt";
import { signPayload } from "./sign";
import { sddxDir } from "./task";

/** The only workspace strategy. Tokens still RECORD the value — a wider read
 * type than the write type, so a token written by an older sddx under `branch`
 * or `none` parses rather than throwing, and is then refused by name. */
const WORKSPACE = "worktree";

export interface Approval {
  plan_sha256: string;
  /** The mode the plan was approved to run under. */
  mode: InteractionMode;
  /** READ-ONLY COMPATIBILITY. Written by versions in which an `auto` plan over a
   * blast-radius bound degraded into `human` and was approved anyway. Bounds are
   * hard refusals now, so no such hybrid exists and nothing writes these — but
   * tokens on disk still carry them and must keep parsing for audit. */
  requested_mode?: InteractionMode;
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
    mode: InteractionMode;
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
  mode: InteractionMode;
  requestedMode: InteractionMode;
  /** Why approval is still required, when `ok` is false. */
  reason?: string;
  /** A hard refusal — not a gate arming. Creation must fail, not ask. */
  refusal?: string;
  /** The same refusal as structured data, for a caller that has to act on the
   * bound rather than print it. Always present when `refusal` is. */
  blocker?: Blocker;
  nodeCount: number;
}

/** Which bound fired. A closed set, because every one of them is a code
 * constant rather than a judgment — that is the whole point of the design. */
export type BlockerBound =
  | "manual-oracle"
  | "unresolved"
  | "workspace"
  | "unconfined-scope"
  | "self-modifying"
  | "protected-path"
  | "task-ceiling";

/**
 * An autonomous blocker, structured. The three fields are what a person (or the
 * session relaying to one) needs to act: what decision is missing or what policy
 * was exceeded, what it means for the run, and what to do next. Rendering them
 * into one line is `renderBlocker`'s job, so the terminal string and the JSON
 * payload can never describe different bounds.
 */
export interface Blocker {
  bound: BlockerBound;
  /** The missing decision, or the policy that was exceeded. */
  decision: string;
  /** What it means for this run. */
  impact: string;
  /** The single next step that unblocks it. */
  next_step: string;
  /** The offending node, when the bound is node-scoped. */
  node?: string;
}

export const renderBlocker = (b: Blocker): string =>
  `${b.node ? `node "${b.node}": ` : ""}${b.decision} — ${b.impact} ${b.next_step}`;

/** Scope globs that reach the machinery enforcing sddx's own gates. A plan that
 * edits the thing enforcing the plan always meets a human, in either mode. */
export const SELF_MODIFYING_GLOBS = [
  "hooks/**",
  "templates/**",
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
 * `src/**` out of this and `src/auth/**` in it.
 *
 * A segment is compared WORD-WISE, not by whole-segment equality: it is split
 * on non-alphanumerics and each word checked against the list. Equality alone
 * read `src/auth/**` as protected but let `src/auth.ts`, `src/auth-service/**`,
 * and `db/migrations.sql` through — scopes that name the protected area more
 * precisely than the directory form that was caught. Word-wise matching also
 * catches the suffix form (`lib/user-auth.ts`).
 *
 * The word boundary is what keeps this from overreaching: `authors/**` and
 * `authority/**` tokenize to one word that is not `auth`, so they still pass.
 * The cost is the reverse — `authentication/**` is one word too and is NOT
 * caught. That is the conservative direction for a *bound* (a missed refusal in
 * auto mode is recoverable; refusing every plan turns auto mode off), and human
 * mode reviews it regardless. */
export function namesSensitiveArea(scope: string[]): string | undefined {
  for (const glob of scope) {
    const segments = glob.replace(/\\/g, "/").split("/");
    for (const seg of segments) {
      for (const word of seg.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word && (SENSITIVE_SEGMENTS as readonly string[]).includes(word)) return word;
      }
    }
    // The last segment names a file. Wildcard-only segments (`**`, `*`) name
    // nothing, which is what keeps `src/**` out of this. Wildcards are stripped
    // before the patterns are applied, because they are anchored with `^`: a
    // planner spelling the same scope `ops/*.env` rather than `ops/.env*` used
    // to decide whether the bound fired at all.
    const last = segments[segments.length - 1] ?? "";
    const literal = last.replace(/[*?]/g, "");
    if (literal && SENSITIVE_FILENAMES.some((re) => re.test(literal))) return last;
  }
  return undefined;
}

/** How a refused auto plan is made actionable. Mode is config-only by design
 * (see `interactionMode`), so the remedy is an edit to a reviewed file — never a
 * flag or an environment variable, both of which the agent composes itself. */
const REMEDY =
  'To review and run this plan yourself, set "interaction_mode": "human" in .sddx/config.json.';

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
  requestedMode: InteractionMode,
  ceiling: number,
  overlaps: (a: string[], b: string[]) => boolean,
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
    // The header is read here rather than passed in, so the CLI predicate and
    // the PreToolUse hook cannot disagree about what the plan declared.
    const blocker = autoRefusal(nodes, ceiling, overlaps, unresolvedOf(graphPath));
    if (blocker) {
      return { ...base, ok: false, mode: "auto", refusal: renderBlocker(blocker), blocker };
    }
  }

  const approval = readApproval(cwd, hash);
  if (approval) {
    // A token vouches for the plan AND the workspace strategy it was rendered
    // under. Worktree is now the only strategy, so this can only fire for a
    // token written by an older sddx under `branch` or `none` — which must not
    // silently authorize a canonical run it was never rendered for. The value is
    // read as a loose string precisely so those legacy tokens still parse.
    if (approval.workspace_mode !== undefined && approval.workspace_mode !== WORKSPACE) {
      return {
        ...base,
        ok: false,
        mode: "human",
        reason: `plan ${hash.slice(0, 12)} was approved for workspace "${approval.workspace_mode}", which is no longer supported — re-render and re-approve this plan`,
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
  unresolved: string[] = [],
): Blocker | undefined {
  // Nobody is present to observe a manual oracle. Incoherence, not risk appetite.
  const manual = nodes.find((n) => n.oracleType === "manual");
  if (manual) {
    return {
      bound: "manual-oracle",
      node: manual.alias,
      decision: "declares oracle.type: manual",
      impact:
        "an unattended run has nobody present to observe it, so completion could never be proven",
      next_step: `Give it an executable oracle, or run it with a human watching. ${REMEDY}`,
    };
  }

  // The ADDITIVE half of the blocker rule. Not every critical decision is
  // path-shaped ("should signup collect date of birth?"), so intake reporting
  // what it could not settle catches the residue the constants below cannot
  // express. It is layered on top of them, never in place of them: the bounds
  // fire whether or not this list is empty, which is what keeps the rule out of
  // the reach of a model that simply reports nothing.
  if (unresolved.length > 0) {
    const list = unresolved.map((u) => `"${u}"`).join(", ");
    return {
      bound: "unresolved",
      decision: `${unresolved.length} decision${unresolved.length === 1 ? "" : "s"} intake could not safely take: ${list}`,
      impact:
        "the plan rests on a choice nobody has made, and an unattended run would make it by accident",
      next_step: `Decide them and record them as answers in the Goal Brief header, or run in human mode. ${REMEDY}`,
    };
  }

  // An EMPTY scope is unconfined — the task may write anywhere, which includes
  // both sddx's own enforcement paths and every protected path below. Treating
  // "no scope" as "no reach" would penalize honest scope declarations and make
  // omitting `scope` the cheapest bypass of both bounds.
  const unconfined = nodes.find((n) => n.scope.length === 0);
  if (unconfined) {
    return {
      bound: "unconfined-scope",
      node: unconfined.alias,
      decision: "declares no scope, so it is unconfined",
      impact: `it may write sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")}) or protected paths (${SENSITIVE_SEGMENTS.join(", ")}, ${SENSITIVE_GLOBS.join(", ")})`,
      next_step: `Declare the smallest scope that covers the work, or run in human mode. ${REMEDY}`,
    };
  }

  const selfModifying = nodes.find((n) => overlaps(n.scope, [...SELF_MODIFYING_GLOBS]));
  if (selfModifying) {
    return {
      bound: "self-modifying",
      node: selfModifying.alias,
      decision: `declares a scope reaching sddx's own enforcement paths (${SELF_MODIFYING_GLOBS.join(", ")})`,
      impact: "a plan that edits the machinery enforcing the plan cannot be bounded by it",
      next_step: `Narrow the scope, or run it with a human reviewing. ${REMEDY}`,
    };
  }

  // Security, data, billing, and deployment decisions. Deterministic by design,
  // and matched two ways — see the SENSITIVE_SEGMENTS note for why one is not enough.
  const PROTECTED_IMPACT =
    "a security, data, billing, or deployment decision is not one an unattended run may take";
  for (const n of nodes) {
    const named = namesSensitiveArea(n.scope);
    if (named) {
      return {
        bound: "protected-path",
        node: n.alias,
        decision: `declares a scope naming the protected area "${named}"`,
        impact: PROTECTED_IMPACT,
        next_step: `Move that work into its own task and run it with a human reviewing. ${REMEDY}`,
      };
    }
  }
  const sensitive = nodes.find((n) => overlaps(n.scope, [...SENSITIVE_GLOBS]));
  if (sensitive) {
    return {
      bound: "protected-path",
      node: sensitive.alias,
      decision: `declares a scope reaching protected paths (${SENSITIVE_GLOBS.join(", ")})`,
      impact: PROTECTED_IMPACT,
      next_step: `Move that work into its own task and run it with a human reviewing. ${REMEDY}`,
    };
  }

  if (nodes.length > ceiling) {
    return {
      bound: "task-ceiling",
      decision: `plan has ${nodes.length} nodes, over the auto_max_tasks ceiling of ${ceiling}`,
      impact:
        "the blast radius of one unattended run is capped deliberately, and this plan exceeds it",
      next_step: `Split the goal into smaller runs, raise auto_max_tasks in reviewed configuration, or run in human mode. ${REMEDY}`,
    };
  }
  return undefined;
}

/** The plan's `unresolved` header list, or empty when the draft is missing or
 * unparseable — an unhashable plan is already refused by the hash check above,
 * so this never has to invent a reason of its own. */
function unresolvedOf(graphPath: string): string[] {
  try {
    return parseGraph(readFileSync(graphPath, "utf8")).graph?.unresolved ?? [];
  } catch {
    return [];
  }
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
