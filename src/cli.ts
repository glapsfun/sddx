import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { auditReceipts } from "./audit";
import { computeBoard } from "./board";
import {
  ADAPTER_SCHEMA_VERSION,
  type Adapter,
  AdapterConflictError,
  type AdapterContext,
  applyAdapter,
  declarationPath,
  planAdapter,
  planHasConflicts,
  uninstallAdapter,
  writeDeclaration,
} from "./lib/adapter";
import { claudeAdapter } from "./lib/adapters/claude";
import {
  approvalPath,
  decideGate,
  type GateDecision,
  type GateNode,
  mergeAssumptions,
  planHash,
  writeApproval,
} from "./lib/approval";
import {
  autoMaxTasks,
  gateInteractionMode,
  INTERACTION_MODES,
  type InteractionMode,
  PACKAGE_MANAGERS,
  type PackageManager,
  RUNTIME_SCOPES,
  type RuntimeScope,
  readConfig,
  resolveConfig,
  validateConfigObject,
} from "./lib/config";
import { runDoctor } from "./lib/doctor";
import {
  branchExists,
  createBranchAt,
  currentBranch,
  defaultBranch,
  deleteBranch,
  forceDeleteBranch,
  isMerged,
} from "./lib/git";
import { scopesOverlap } from "./lib/glob-overlap";
import {
  createGoal,
  currentlyMergedTaskIds,
  findGoalForTask,
  goalExists,
  goalId,
  goalPath,
  readGoal,
  runBranchName,
} from "./lib/goal";
import {
  briefAssumptions,
  type Graph,
  type GraphNode,
  parseGraph,
  truncateToHeader,
  validateSchedule,
} from "./lib/graph";
import { runHook } from "./lib/hookdispatch";
import {
  applyInit,
  type FileOp,
  InitApplyError,
  type InitOptions,
  type InitPlan,
  NotAGitRepositoryError,
  planInit,
  planIsNoop,
  repositoryRoot,
} from "./lib/init";
import { parseQuestionBatch, QUESTION_CAP } from "./lib/intake";
import { detectRunState, renderMenu, resolveSelection, runActions } from "./lib/next-actions";
import { type OutputFormat, parseOutputFlag, printError, printLine, Reporter } from "./lib/output";
import { createGoalPr } from "./lib/pr";
import { sha256 } from "./lib/receipt";
import { redCheck } from "./lib/redcheck";
import { generateRunReport, renderRunReport } from "./lib/runreport";
import { sddxCommand } from "./lib/runtime";
import { parseSpec, type Spec } from "./lib/spec";
import {
  abandonOrRetry,
  allowPath,
  createTask,
  type Phase,
  readTask,
  resolveTaskState,
  sddxDir,
  taskId,
  transition,
  writeTask,
} from "./lib/task";
import { verifyTask } from "./lib/verify";
import {
  createWorktree,
  isDirty,
  materializeDependent,
  removeWorktree,
  removeWorktreeForced,
  resolveBaseRef,
  resolveMainRepoRoot,
  retryWorkspace,
  submoduleScopeConflicts,
  sweep,
  worktreeAvailable,
  worktreesDir,
} from "./lib/worktree";

const USAGE = `usage:
  sddx init [--runtime <global|project>] [--package-manager <npm|bun>]
            [--adapter <name>]... [--interaction-mode <human|auto>] [--yes] [--dry-run]
  sddx doctor
  sddx sync --adapter <name> [--yes] [--force]
  sddx uninstall --adapter <name>
  sddx task phase <id> <PHASE> [--test-exit <n>]
  sddx task allow <id> <path>
  sddx task show <id>
  sddx task materialize <id>
  sddx red-check <id>
  sddx verify <id> [--model <m>] [--harness <h>]
  sddx goal show <id>
  sddx intake check --batch <path>
  sddx graph create --graph <path> [--dry-run]
  sddx graph approve --graph <path>
  sddx graph regenerate --graph <path>
  sddx graph cancel --graph <path>
  sddx pr create --goal <goal-id> [--title <title>]
  sddx run report --goal <goal-id>
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
  sddx next-actions --goal <goal-id> [--select <reply>]
  sddx config show [--json (deprecated, use --output json)]
  sddx config validate

global flags (any command):
  --output <terminal|json|markdown|all>  (default: terminal)
  --no-color`;

// Set once at the top of main() from the parsed --output/--no-color flags, so
// fail()/failWith() — called from validation code that runs before any
// command-specific Reporter exists — can still honor the requested format
// instead of always falling back to plain stderr text.
let currentFormat: OutputFormat = "terminal";
let currentNoColor = false;
let currentCommand = "sddx";

/** Fatal error exit, format-aware: plain stderr text in terminal mode (as
 * before), or a proper `status: "error"` envelope in json/markdown mode so
 * automation parsing `--output json` never has to handle unstructured text. */
function failWith(messages: string[], code: 1 | 2 | 3 = 1, data: unknown = null): never {
  if (currentFormat === "terminal") {
    for (const m of messages) printError(m);
  } else {
    const reporter = makeReporter(currentCommand, currentFormat, currentNoColor);
    for (const m of messages) reporter.error(m);
    reporter.finish(data, { status: "error" });
  }
  process.exit(code);
}

function fail(message: string, code: 1 | 2 | 3 = 1): never {
  failWith([message], code);
}

function makeReporter(command: string, format: OutputFormat, noColor: boolean): Reporter {
  currentFormat = format;
  currentNoColor = noColor;
  currentCommand = command;
  return new Reporter(command, format, {
    noColor,
    pluginVersion: sddxVersion(),
    harness: "claude-code",
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} requires a value`, 2);
  return v;
}

/**
 * Flags removed in 4.0, refused by name.
 *
 * Silently ignoring one is the worst option: `--workspace none` is a request
 * for NO isolation, so dropping it without a word would hand the caller the
 * opposite of what they asked for and never say so. Every other removed
 * surface (`task create`, `goal create`, the retired config keys) names itself;
 * this keeps the flags consistent with them.
 */
const REMOVED_FLAGS: ReadonlyMap<string, string> = new Map([
  [
    "--workspace",
    "worktree is the only workspace strategy in sddx 4.0, so there is nothing to select. Drop the flag.",
  ],
  [
    "--no-branch",
    "in-place execution was removed in sddx 4.0 — every task runs in its own worktree. Drop the flag.",
  ],
]);

function rejectRemovedFlags(args: string[]): void {
  for (const [flagName, why] of REMOVED_FLAGS) {
    if (args.includes(flagName)) {
      failWith([`\`${flagName}\` was removed: ${why}`, "See docs/how-to/migrate-to-v4.md."], 2);
    }
  }
}

/**
 * The product version, and the only version source there is.
 *
 * Resolved relative to this module's own URL so it works identically from a
 * cloned checkout (`src/cli.ts` → `../package.json`) and from an installed
 * package (`dist/cli.mjs` → `../package.json`), including when a global install
 * reached the bundle through a symlinked `bin` entry.
 *
 * This value is what gets stamped into a receipt's `plugin_version` field. The
 * FIELD keeps its name — receipts are immutable and hash-chained, so renaming
 * it would invalidate every historical receipt at the version boundary and
 * break `sddx audit` across it. It is a wire-format name, not a claim about
 * where the number is read from. See docs/reference/receipts.md.
 */
function sddxVersion(): string {
  try {
    const manifest = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/**
 * Undo log for a partially completed initialization.
 *
 * Recorded as each artifact is created and replayed in REVERSE order, because
 * the dependencies run that way: a worktree holds a checkout of its branch, so
 * the branch cannot be deleted until the worktree is gone.
 *
 * Every step is best-effort and independently reported. A rollback that threw
 * on the first stubborn artifact would leave the rest behind while claiming to
 * have cleaned up, which is worse than the partial run it was fixing.
 */
class Rollback {
  private steps: Array<{ describe: string; undo: (cwd: string) => void }> = [];

  branch(name: string): void {
    this.steps.push({
      describe: `branch ${name}`,
      undo: (cwd) => {
        if (branchExists(cwd, name)) forceDeleteBranch(cwd, name);
      },
    });
  }

  worktree(absPath: string): void {
    this.steps.push({
      describe: `worktree ${absPath}`,
      undo: (cwd) => {
        if (existsSync(absPath)) removeWorktreeForced(cwd, absPath);
      },
    });
  }

  taskState(id: string): void {
    this.steps.push({
      describe: `task state ${id}`,
      undo: (cwd) => {
        for (const p of [
          join(sddxDir(cwd), "tasks", `${id}.json`),
          join(sddxDir(cwd), "specs", `${id}.yaml`),
        ]) {
          if (existsSync(p)) rmSync(p, { force: true });
        }
      },
    });
  }

  /** Replays every step newest-first. Returns what could not be removed. */
  run(cwd: string): string[] {
    const stuck: string[] = [];
    for (const step of [...this.steps].reverse()) {
      try {
        step.undo(cwd);
      } catch (e) {
        stuck.push(`${step.describe} (${(e as Error).message})`);
      }
    }
    return stuck;
  }
}

/** Create a root task in its own worktree. `specSrc` is the absolute path of the
 * spec file to copy into the task's `.sddx/specs/`. `forkSha`, when given (a
 * goal's run branch tip), is used as the worktree's fork point instead of
 * resolving `origin/HEAD` independently per task — every root task in a run
 * forks from the same run branch state.
 *
 * Worktree is the invariant: there is no mode parameter because there is
 * nothing to select. A repository that cannot host a worktree is refused in
 * `resolvePlan`'s preconditions, loudly, rather than downgraded here. */
function createRootTask(
  cwd: string,
  spec: Spec,
  specSrc: string,
  reporter: Reporter,
  forkSha?: string,
): { id: string; line: string } {
  const id = taskId(spec.task);
  let baseSha: string;
  if (forkSha) {
    baseSha = forkSha;
  } else {
    const base = resolveBaseRef(cwd);
    if (base.source === "HEAD") reporter.success("no origin remote — forking from local HEAD");
    baseSha = base.sha;
  }
  const wtPath = createWorktree(cwd, id, baseSha);
  const relPath = join(".sddx-worktrees", id);
  mkdirSync(join(sddxDir(wtPath), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(specSrc, join(wtPath, specPath));
  createTask(wtPath, spec, specPath, {
    mode: "worktree",
    branch: `sddx/${id}`,
    base_sha: baseSha,
    path: relPath,
  });
  return {
    id,
    line: `created ${id} phase=PLAN worktree=${relPath} branch=sddx/${id} base=${baseSha}`,
  };
}

/** Create a deferred dependent task in the main checkout — no worktree yet, base
 * `pending:<parent-id>[,<parent-id>...]`. Materialized once every named parent
 * is DONE (single fork, or a sequential merge for fan-in — see worktree.ts). */
function createDeferredTask(cwd: string, spec: Spec, specSrc: string, dependsOn: string[]): string {
  const id = taskId(spec.task);
  mkdirSync(join(sddxDir(cwd), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(specSrc, join(cwd, specPath));
  createTask(
    cwd,
    spec,
    specPath,
    {
      mode: "deferred",
      materialize_as: "worktree",
      branch: null,
      base_sha: `pending:${dependsOn.join(",")}`,
    },
    { dependsOn },
  );
  return id;
}

/** Roots first, a node only after every one of its parents — cherry-pick/commit
 * order must equal dependency order. Assumes an already-validated (acyclic) graph. */
function topoOrder(nodes: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = [];
  const emitted = new Set<string>();
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const ready = remaining.filter((n) => n.depends_on.every((d) => emitted.has(d)));
    if (ready.length === 0) break; // defensive: a cycle slipped past validation
    for (const n of ready) {
      out.push(n);
      emitted.add(n.alias);
    }
    remaining = remaining.filter((n) => !emitted.has(n.alias));
  }
  return out;
}

/**
 * Everything `graph create` resolves and validates before it is entitled to
 * write anything. `--dry-run` and a real create both go through this and only
 * this, so the facts a human approves (base SHA, node set) cannot drift from
 * the facts creation acts on.
 *
 * There is no workspace mode here. Worktree is the invariant; a repository that
 * cannot host one is refused below with a stated precondition, never downgraded.
 */
interface ResolvedPlan {
  graph: Graph;
  /** Per-alias parsed spec plus the absolute path it was read from. */
  loaded: Map<string, { spec: Spec; src: string }>;
  idByAlias: Map<string, string>;
  goalId: string;
  base: ReturnType<typeof resolveBaseRef>;
  /** Notices produced while resolving (e.g. "no origin remote — forking from local HEAD"). */
  notices: string[];
  errors: string[];
}

function resolvePlan(cwd: string, graphArg: string): ResolvedPlan {
  let graphText: string;
  try {
    graphText = readFileSync(join(cwd, graphArg), "utf8");
  } catch {
    fail(`cannot read graph file: ${graphArg}`);
  }
  const { graph, errors: graphErrors } = parseGraph(graphText);
  if (!graph) {
    failWith(graphErrors.map((e) => `graph error: ${e}`));
  }

  // Validate EVERYTHING before writing anything (atomic): each node's spec has a
  // valid oracle, task ids are unique/free, and the schedule satisfies overlap ⟹
  // ordered. Specs are resolved relative to the graph file's directory.
  const graphDir = dirname(join(cwd, graphArg));
  const errs: string[] = [];
  const loaded = new Map<string, { spec: Spec; src: string }>();
  const idByAlias = new Map<string, string>();
  for (const node of graph.tasks) {
    const src = resolve(graphDir, node.spec);
    let text: string;
    try {
      text = readFileSync(src, "utf8");
    } catch {
      errs.push(`${node.alias}: cannot read spec ${node.spec}`);
      continue;
    }
    const { spec, errors } = parseSpec(text);
    if (!spec) {
      for (const e of errors) errs.push(`${node.alias}: spec error: ${e}`);
      continue;
    }
    const id = taskId(spec.task);
    if (resolveTaskState(cwd, id)) errs.push(`${node.alias}: task ${id} already exists`);
    for (const [otherAlias, otherId] of idByAlias) {
      if (otherId === id) errs.push(`${node.alias}: task id ${id} collides with ${otherAlias}`);
    }
    idByAlias.set(node.alias, id);
    // Cross-cutting assumptions and recorded answers are copied in here, before
    // the spec is registered, so each receipt states its conditions — and what
    // the user decided — without needing the goal file to interpret it.
    loaded.set(node.alias, {
      spec: { ...spec, assumptions: mergeAssumptions(briefAssumptions(graph), spec.assumptions) },
      src,
    });
  }
  errs.push(
    ...validateSchedule(
      graph.tasks.map((n) => ({
        id: n.alias,
        dependsOn: n.depends_on,
        scope: loaded.get(n.alias)?.spec.scope ?? [],
      })),
    ),
  );
  const gid = goalId(graph.goal);
  if (existsSync(goalPath(cwd, gid))) errs.push(`goal error: goal ${gid} already exists`);

  // Resolve the two facts a human needs but the drafts never carry: where this
  // would fork from, and which workspace strategy would actually be used after
  // any auto-downgrade. Both are recorded so the render and the real create
  // report identically.
  const notices: string[] = [];
  const base = resolveBaseRef(cwd);
  if (base.source === "HEAD") notices.push("no origin remote — forking from local HEAD");
  // Worktree preconditions. There is no downgrade to fall back to, so these are
  // refusals: a failed precondition names itself and states that no run was
  // started. Checked here so a dry run reports exactly what a real create would
  // refuse. Scope-scoped rather than repository-wide: a vendored submodule no
  // task touches is not a reason to refuse the run.
  if (!worktreeAvailable(cwd)) {
    errs.push(
      "worktree unavailable: git cannot create worktrees for this repository. No run was started. Use a checkout where `git worktree list` succeeds.",
    );
  }
  for (const c of submoduleScopeConflicts(
    cwd,
    base.sha,
    graph.tasks.map((n) => ({ alias: n.alias, scope: loaded.get(n.alias)?.spec.scope ?? [] })),
  )) {
    errs.push(
      c.scope
        ? `unsupported layout: task "${c.alias}" declares scope ${c.scope}, which reaches the submodule ${c.submodule}. A worktree crossing a submodule boundary is unsafe, and no run was started.`
        : `unsupported layout: task "${c.alias}" declares no scope, so it cannot be proven disjoint from the submodule ${c.submodule}. Declare a scope, or use a checkout without submodules. No run was started.`,
    );
  }

  // Name and destination availability. These used to surface DURING creation —
  // a collision on the third task appeared after the run branch and two
  // worktrees already existed — so they belong in preflight, before any
  // mutation, together with everything else above.
  const runBranch = runBranchName(gid);
  if (branchExists(cwd, runBranch)) {
    errs.push(`run branch ${runBranch} already exists — remove it or choose a different goal`);
  }
  for (const [alias, id] of idByAlias) {
    if (branchExists(cwd, `sddx/${id}`)) {
      errs.push(`${alias}: task branch sddx/${id} already exists`);
    }
    if (existsSync(join(worktreesDir(resolveMainRepoRoot(cwd)), id))) {
      errs.push(`${alias}: worktree destination .sddx-worktrees/${id} already exists`);
    }
  }

  return { graph, loaded, idByAlias, goalId: gid, base, notices, errors: errs };
}

/**
 * One node's approval-relevant facts — the unit a re-render diffs on.
 *
 * Every field of the spec is represented, not just the four a listing shows. A
 * diff that covered only task/oracle/scope/depends_on would report "changes
 * since last render: none" after `success_criteria` was rewritten, so a human
 * re-reviewing would approve narrowed acceptance criteria believing nothing
 * moved. `rest` is a digest over everything else, so no field can change
 * silently — new spec fields are covered automatically.
 */
function planNodeSummary(plan: ResolvedPlan, alias: string): Record<string, string> {
  const node = plan.graph.tasks.find((n) => n.alias === alias);
  const spec = plan.loaded.get(alias)?.spec;
  const shown = {
    task: spec?.task ?? "(unreadable)",
    oracle: spec ? `${spec.oracle.type}: ${spec.oracle.run} (expect ${spec.oracle.expect})` : "-",
    scope: (spec?.scope ?? []).join(", ") || "(unscoped)",
    depends_on: (node?.depends_on ?? []).join(", ") || "(root)",
  };
  return {
    ...shown,
    success_criteria: (spec?.success_criteria ?? []).join(" | ") || "(none)",
    assumptions: (spec?.assumptions ?? []).join(" | ") || "(none)",
    out_of_scope: (spec?.out_of_scope ?? []).join(" | ") || "(none)",
    stop_rules: JSON.stringify(spec?.stop_rules ?? []),
    // catch-all so a field added to Spec later cannot slip past this diff
    rest: spec
      ? sha256(
          JSON.stringify({
            ...spec,
            task: undefined,
            oracle: undefined,
            scope: undefined,
            success_criteria: undefined,
            assumptions: undefined,
            out_of_scope: undefined,
            stop_rules: undefined,
          }),
        ).slice(0, 12)
      : "-",
  };
}

/**
 * The Goal Brief's approval-relevant facts — the second unit a re-render diffs
 * on, and for the same reason the node summary covers every spec field. The
 * node summaries only cover the decomposition, so an edit to a constraint, an
 * acceptance criterion, or the unresolved list — the header the whole plan was
 * built ON — re-rendered as "changes since last render: none", telling a human
 * following the skill's "a second read is cheap" instruction that nothing moved.
 */
function planBriefSummary(graph: Graph): Record<string, string> {
  const list = (xs: string[]): string => xs.join(" | ") || "(none)";
  return {
    goal: graph.goal,
    answers: list(graph.answers.map((a) => `${a.question} → ${a.answer}`)),
    assumptions: list(graph.assumptions),
    constraints: list(graph.constraints),
    acceptance_criteria: list(graph.acceptance_criteria),
    out_of_scope: list(graph.out_of_scope),
    unresolved: list(graph.unresolved),
  };
}

/**
 * The plan-review stage offers these and nothing else. A fifth action here
 * would be one taken before the plan was authorized, which is the one thing
 * this stage exists to prevent; the post-run handoff is a different menu at a
 * different point (`next-actions --goal`), and the two are never combined.
 */
const PLAN_ACTIONS = ["Approve", "Edit", "Regenerate", "Cancel"] as const;

/** Where plan drafts live, by convention every skill and agent follows — and
 * the only directory the Regenerate/Cancel actions may write or delete in. */
const draftsDir = (cwd: string): string => join(sddxDir(cwd), "drafts");

/** Whether `path` is inside `dir`. Resolved-path comparison, so a `..` segment
 * in a draft-supplied path cannot escape. */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Where the last render of this plan was cached, so a re-render can show only
 * what moved. Keyed by goal id — a revision that changes the goal sentence is a
 * different plan and correctly renders in full. */
const renderCachePath = (cwd: string, gid: string): string =>
  join(draftsDir(cwd), `.render-${gid}.json`);

/** Discards the cached render, so the next dry run of a re-planned goal renders
 * in full instead of diffing against a plan that no longer exists. The key is
 * the goal id, derived from the goal sentence — so a Regenerate or Cancel
 * followed by re-planning the same sentence would otherwise land on the same
 * cache entry. */
function dropRenderCache(cwd: string, gid: string | null): void {
  if (gid !== null) rmSync(renderCachePath(cwd, gid), { force: true });
}

function renderPlan(cwd: string, graphArg: string, plan: ResolvedPlan, reporter: Reporter): void {
  const mode = gateInteractionMode(cwd);
  const order = topoOrder(plan.graph.tasks).map((n) => n.alias);
  const current: Record<string, Record<string, string>> = {};
  for (const alias of order) current[alias] = planNodeSummary(plan, alias);
  const currentBrief = planBriefSummary(plan.graph);

  const { hash } = planHash(join(cwd, graphArg));

  // What a real create would bring into existence. Only ROOT tasks get a
  // worktree up front; a dependent is deferred until every parent is DONE, so
  // reporting one worktree per task would overstate what is about to happen.
  const targetBranch = defaultBranch(cwd);
  const runBranch = runBranchName(plan.goalId);
  const worktreeCount = plan.graph.tasks.filter((n) => n.depends_on.length === 0).length;

  const lines: string[] = [
    `goal: ${plan.graph.goal}`,
    `plan: ${hash.slice(0, 12)} (${order.length} node${order.length === 1 ? "" : "s"})`,
    `target branch: ${targetBranch}`,
    `run branch: ${runBranch} (not created yet)`,
    `worktrees: ${worktreeCount} at creation, ${order.length} once every dependent materializes`,
    `base: ${plan.base.sha} (${plan.base.source})`,
    "validation: passed",
    "",
  ];

  // The Goal Brief header, so the one artifact the gate depends on shows what
  // the plan was built ON — what the user decided, what sddx assumed on their
  // behalf, and what nobody settled — not just the decomposition it produced.
  // Sections a header does not declare are omitted rather than shown empty.
  const brief = plan.graph;
  // The header records the mode intake was DISPATCHED under; the gate reads
  // `.sddx/config.json` and nothing else (see `gateInteractionMode`), so an
  // agent-authored header can never widen the gate. When the two disagree the
  // render would otherwise state both as fact in one payload, leaving a reader
  // of `brief.interactionMode` believing a run is human-gated when it is not.
  const modeDiverges = brief.interaction_mode !== mode;
  if (modeDiverges) {
    lines.push(
      `planned under interaction_mode: ${brief.interaction_mode}, configured mode is ${mode} — the configured mode governs this run`,
      "",
    );
  }
  if (brief.answers.length > 0) {
    lines.push("answered:");
    for (const a of brief.answers) lines.push(`  ${a.question} → ${a.answer}`);
    lines.push("");
  }
  if (brief.assumptions.length > 0) {
    lines.push("assumptions:");
    for (const a of brief.assumptions) lines.push(`  ${a}`);
    lines.push("");
  }
  if (brief.constraints.length > 0) {
    lines.push("constraints:");
    for (const c of brief.constraints) lines.push(`  ${c}`);
    lines.push("");
  }
  if (brief.acceptance_criteria.length > 0) {
    lines.push("acceptance criteria:");
    for (const a of brief.acceptance_criteria) lines.push(`  ${a}`);
    lines.push("");
  }
  if (brief.out_of_scope.length > 0) {
    lines.push("out of scope:");
    for (const o of brief.out_of_scope) lines.push(`  ${o}`);
    lines.push("");
  }
  if (brief.unresolved.length > 0) {
    lines.push("unresolved:");
    for (const u of brief.unresolved) lines.push(`  ${u}`);
    lines.push("");
  }

  // Diff against the previous render of this same plan, when there was one — a
  // second read must cost only what changed, or the gate stops being read.
  let previous: Record<string, Record<string, string>> | null = null;
  let previousBrief: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(renderCachePath(cwd, plan.goalId), "utf8")) as Record<
      string,
      unknown
    >;
    // A cache written before the header was diffed holds the node map at the
    // top level. Read it as nodes-only rather than reporting every brief field
    // as changed on the first render after an upgrade.
    const versioned = "nodes" in parsed && "brief" in parsed;
    previous = (versioned ? parsed.nodes : parsed) as typeof current;
    previousBrief = versioned ? (parsed.brief as Record<string, string>) : null;
  } catch {
    previous = null;
  }

  // The plan itself is ALWAYS rendered. The diff below is an addition to it, not
  // a replacement: the cache is primed by any dry run — including the agent's own
  // review render, which is ungated — so putting the listing in the `else` arm
  // meant the human, following the approval dialog's own instruction to run
  // `--dry-run`, saw a hash and "changes since last render: none" describing
  // nothing. The one artifact the whole gate depends on rendered empty in the
  // normal flow.
  lines.push("execution order:");
  for (const alias of order) {
    const s = current[alias];
    lines.push(`  ${alias}: ${s.task}`);
    lines.push(`      criteria:   ${s.success_criteria}`);
    lines.push(`      oracle:     ${s.oracle}`);
    lines.push(`      scope:      ${s.scope}`);
    lines.push(`      depends_on: ${s.depends_on}`);
  }

  if (previous) {
    const changed: string[] = [];
    const beforeBrief = previousBrief;
    if (beforeBrief) {
      const fields = Object.keys(currentBrief).filter((f) => beforeBrief[f] !== currentBrief[f]);
      if (fields.length > 0) {
        changed.push("  ~ goal brief");
        for (const f of fields) changed.push(`      ${f}: ${beforeBrief[f]} → ${currentBrief[f]}`);
      }
    }
    for (const alias of order) {
      const before = previous[alias];
      const after = current[alias];
      if (!before) {
        changed.push(`  + ${alias} (new)`);
        continue;
      }
      const fields = Object.keys(after).filter((k) => before[k] !== after[k]);
      if (fields.length > 0) {
        changed.push(`  ~ ${alias}`);
        for (const f of fields) changed.push(`      ${f}: ${before[f]} → ${after[f]}`);
      }
    }
    for (const alias of Object.keys(previous)) {
      if (!current[alias]) changed.push(`  - ${alias} (removed)`);
    }
    lines.push(
      "",
      changed.length > 0 ? "changes since last render:" : "changes since last render: none",
      ...changed,
    );
  }
  // Exactly four actions, and only in human mode. Auto renders no menu and
  // waits for no selection — a run recorded `auto` must never have a human
  // approval hiding underneath it, and offering one here is how that happens.
  // Printing the menu authorizes nothing: each line names the command the USER
  // runs, and `graph create` still exits 3 without a token.
  const actions = mode === "human" ? PLAN_ACTIONS : [];
  if (actions.length > 0) {
    lines.push("", "actions:");
    lines.push(`  Approve    — ... graph approve --graph ${graphArg}`);
    lines.push("  Edit       — revise the drafts, then re-render (any edit re-arms the gate)");
    lines.push(`  Regenerate — ... graph regenerate --graph ${graphArg} (keeps the Goal Brief)`);
    lines.push(`  Cancel     — ... graph cancel --graph ${graphArg}`);
  }

  lines.push("", "nothing written — this is a dry run");
  reporter.success(lines.join("\n"));

  try {
    mkdirSync(dirname(renderCachePath(cwd, plan.goalId)), { recursive: true });
    writeFileSync(
      renderCachePath(cwd, plan.goalId),
      JSON.stringify({ nodes: current, brief: currentBrief }),
    );
  } catch {
    // a cache we cannot write costs a full re-render, never a failed dry run
  }

  reporter.finish({
    dryRun: true,
    goal: plan.graph.goal,
    goalId: plan.goalId,
    planSha256: hash,
    workspaceMode: "worktree",
    baseSha: plan.base.sha,
    // The task ids and run branch a real create WOULD produce. Both are
    // resolved during preflight already; omitting them left the dry run unable
    // to answer "what will this create", which is the question it exists for.
    runBranch,
    aliasToId: Object.fromEntries(plan.idByAlias),
    taskIds: [...plan.idByAlias.values()],
    executionOrder: order,
    nodes: current,
    targetBranch,
    worktreeCount,
    taskCount: order.length,
    interactionMode: mode,
    actions,
    // True when the header's mode is not the one that governs — so a structured
    // consumer reading `brief.interactionMode` cannot mistake it for the gate's.
    interactionModeDiverges: modeDiverges,
    brief: {
      interactionMode: brief.interaction_mode,
      answers: brief.answers,
      assumptions: brief.assumptions,
      constraints: brief.constraints,
      acceptanceCriteria: brief.acceptance_criteria,
      outOfScope: brief.out_of_scope,
      unresolved: brief.unresolved,
    },
  });
}

/** The gate inputs a resolved plan supplies, in the shape `decideGate` wants. */
function gateNodes(plan: ResolvedPlan): GateNode[] {
  return plan.graph.tasks.map((n) => ({
    alias: n.alias,
    scope: plan.loaded.get(n.alias)?.spec.scope ?? [],
    oracleType: plan.loaded.get(n.alias)?.spec.oracle.type ?? "command",
  }));
}

/**
 * Mode for a gate decision comes from `.sddx/config.json` alone — never from a
 * flag or the environment, both of which are part of the command line the agent
 * composes (see `gateInteractionMode`). The token must also match the workspace
 * strategy actually in play, since `--workspace none` abandons isolation.
 */
function resolveApproval(cwd: string, graphArg: string, plan: ResolvedPlan): GateDecision {
  return decideGate(
    cwd,
    join(cwd, graphArg),
    gateNodes(plan),
    gateInteractionMode(cwd),
    autoMaxTasks(cwd),
    scopesOverlap,
  );
}

function cmdGraphApprove(
  cwd: string,
  args: string[],
  format: OutputFormat,
  noColor: boolean,
): void {
  const reporter = makeReporter("graph approve", format, noColor);
  const graphArg = flag(args, "--graph");
  if (!graphArg) fail(USAGE, 2);
  // Never approve a plan that would be rejected — the same validation creation
  // runs, so approval can't be granted to something that cannot execute.
  const plan = resolvePlan(cwd, graphArg);
  if (plan.errors.length > 0) {
    failWith(plan.errors.map((e) => `graph approve: ${e}`));
  }
  const { hash, errors } = planHash(join(cwd, graphArg));
  if (hash === "") failWith(errors.map((e) => `graph approve: ${e}`));

  // Run the gate's HARD refusals here too. Without this, approving a plan whose
  // node declares `oracle.type: manual` under `interaction_mode: auto` reports
  // success and writes a token, and the very next `graph create` refuses it —
  // telling a human who just approved as a human to "run in human mode".
  const decision = decideGate(
    cwd,
    join(cwd, graphArg),
    gateNodes(plan),
    gateInteractionMode(cwd),
    autoMaxTasks(cwd),
    scopesOverlap,
  );
  if (decision.refusal) {
    failWith([`graph approve: ${decision.refusal}`], 1, { blocker: decision.blocker });
  }

  // A token always records `mode: "human"`. Approving IS the deliberate act, so
  // recording the *configured* mode here would let a `mode: auto` receipt mean
  // "a human approved it after all" — destroying the one thing that marker is
  // for: identifying plans no human ever saw.
  //
  // Nothing records a degradation any more. An `auto` plan over a bound is
  // refused above, so the case those fields described — configured `auto`,
  // approved by a human anyway — can no longer occur.
  const approval = writeApproval(cwd, {
    plan_sha256: hash,
    mode: "human",
    workspace_mode: "worktree",
  });
  reporter.success(`approved plan ${hash} (mode ${approval.mode})`);
  reporter.success(`token: ${approvalPath(cwd, hash)}`);
  if (approval.signature) reporter.success(`signed by ${approval.signer}`);
  reporter.finish({
    planSha256: hash,
    mode: approval.mode,
    tokenPath: approvalPath(cwd, hash),
    signed: Boolean(approval.signature),
    nodes: plan.graph.tasks.length,
  });
}

function cmdGraphCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const dryRun = args.includes("--dry-run");
  const reporter = makeReporter(
    dryRun ? "graph create --dry-run" : "graph create",
    format,
    noColor,
  );
  const graphArg = flag(args, "--graph");
  if (!graphArg) fail(USAGE, 2);
  const plan = resolvePlan(cwd, graphArg);
  const { graph, loaded, base } = plan;
  const gid = plan.goalId;
  const errs = plan.errors;
  if (errs.length > 0) {
    failWith(errs.map((e) => `graph error: ${e}`));
  }
  for (const n of plan.notices) reporter.success(n);

  if (dryRun) {
    renderPlan(cwd, graphArg, plan, reporter);
    return;
  }

  // The approval predicate, checked after validation (a plan that would be
  // rejected must never reach a human) and before the first write. This is the
  // CLI half of the gate — it holds when sddx is driven outside a hook-capable
  // harness, but on its own it only proves the plan is the approved plan, not
  // that a human approved it. The PreToolUse dialog is what a model can't
  // self-grant. Exit 3 marks "approval required", distinct from 1 and 2.
  const gate = resolveApproval(cwd, graphArg, plan);
  // A hard refusal fails (exit 1) rather than arming the gate — asking a human
  // to approve an incoherent plan is worse than refusing it outright. The
  // structured blocker rides along so a caller can act on the bound that fired
  // instead of parsing the sentence describing it.
  if (gate.refusal) failWith([`graph create: ${gate.refusal}`], 1, { blocker: gate.blocker });
  if (!gate.ok) {
    failWith([`graph create: ${gate.reason}`], 3);
  }

  // Gate passed. Everything from here mutates the repository, so it is wrapped:
  // a failure partway through must not leave a half-run behind, whose goal id
  // would then collide on the retry the user is about to attempt.
  const undo = new Rollback();
  // Worktrees are created against the main repo root, so preflight and rollback
  // must use the same anchor — resolving them from `cwd` made both blind to a
  // worktree created anywhere but the repo root.
  const mainRepoRoot = resolveMainRepoRoot(cwd);
  const aliasToId = new Map<string, string>();
  const deps: Record<string, string[]> = {};
  const created: string[] = [];
  let g: ReturnType<typeof createGoal>;
  // Create the run branch first — before any task worktree — from the same base
  // every root task would otherwise resolve independently
  // (run-branch-integration): one fork point for the whole run, not one per task.
  const runBranch = runBranchName(gid);
  try {
    createBranchAt(cwd, runBranch, base.sha);
    undo.branch(runBranch);
    reporter.success(`created run branch ${runBranch} at ${base.sha}`);

    // Now create tasks in dependency order (roots fork from the run branch's
    // tip; dependents are deferred), then register the goal with its edges.
    for (const node of topoOrder(graph.tasks)) {
      const { spec, src } = loaded.get(node.alias) as { spec: Spec; src: string };
      if (node.depends_on.length === 0) {
        // Registered BEFORE creation, not after. createRootTask creates the
        // worktree and branch first and only then copies the spec and writes
        // task state, so a throw in that tail used to escape with nothing
        // recorded — and the CLI would then report a complete rollback while
        // the worktree and branch survived. Every undo step is existence-
        // checked, so registering an artifact that was never created is a no-op.
        //
        // Order matters too: replay is reverse, and a branch cannot be deleted
        // while a worktree still has it checked out, so branch is registered
        // first to be undone last.
        const id = plan.idByAlias.get(node.alias) as string;
        undo.branch(`sddx/${id}`);
        undo.worktree(join(worktreesDir(mainRepoRoot), id));
        undo.taskState(id);
        const created0 = createRootTask(cwd, spec, src, reporter, base.sha);
        aliasToId.set(node.alias, created0.id);
        created.push(created0.id);
        reporter.success(created0.line);
      } else {
        const parentIds = node.depends_on.map((alias) => aliasToId.get(alias) as string);
        const id = plan.idByAlias.get(node.alias) as string;
        undo.taskState(id);
        createDeferredTask(cwd, spec, src, parentIds);
        aliasToId.set(node.alias, id);
        created.push(id);
        deps[id] = parentIds;
        reporter.success(
          `created ${id} phase=PLAN depends_on=${parentIds.join(",")} workspace=deferred(worktree)`,
        );
      }
    }
    // `.sddx/goals/<id>.json` is deliberately plain, never-committed local
    // coordination state (like `.sddx/sweep.json`) — see the matching comment
    // in `runbranch.ts`. Committing it would tie it to whatever branch happens
    // to be checked out when that commit lands, breaking every later
    // `readGoal`/`findGoalForTask` call once anything switches away from it.
    g = createGoal(cwd, graph.goal, created, {
      deps,
      id: gid,
      runBranch,
      baseSha: base.sha,
      approval: {
        mode: gate.mode,
        // A token always records `mode: human` (approving IS the deliberate
        // act), so a human-resolved gate is exactly a matched token.
        authorization: gate.mode === "human" ? "human-approval" : "auto",
        plan_sha256: gate.hash,
        at: new Date().toISOString(),
      },
    });
  } catch (e) {
    const stuck = undo.run(mainRepoRoot);
    failWith([
      `graph create: initialization failed — ${(e as Error).message}`,
      ...(stuck.length > 0
        ? [
            "graph create: rollback could not remove the following; remove them by hand before retrying:",
            ...stuck.map((s) => `  ${s}`),
          ]
        : ["graph create: everything this attempt created was rolled back; no run was started."]),
    ]);
  }
  reporter.success(`created goal ${g.id} tasks=[${g.task_ids.join(", ")}] run_branch=${runBranch}`);
  for (const [alias, id] of aliasToId) reporter.success(`  ${alias} → ${id}`);
  reporter.finish({
    goalId: g.id,
    taskIds: g.task_ids,
    aliasToId: Object.fromEntries(aliasToId),
    runBranch,
    baseSha: base.sha,
  });
}

function cmdTaskPhase(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("task phase", format, noColor);
  const [id, phase] = args;
  if (!id || !phase) fail(USAGE, 2);
  const testExitRaw = flag(args, "--test-exit");
  const task = readTask(cwd, id);
  if (phase === "ABANDONED") {
    const outcome = abandonOrRetry(task);
    if (outcome.retried) {
      retryWorkspace(cwd, task);
      writeTask(cwd, task);
      reporter.success(`${id} retry ${outcome.attempt_count}/${outcome.max_attempts} → phase=PLAN`);
      reporter.finish({
        id,
        phase: task.phase,
        retried: true,
        attempt_count: outcome.attempt_count,
        max_attempts: outcome.max_attempts,
      });
      return;
    }
    writeTask(cwd, task);
    reporter.success(`${id} phase=${task.phase}`);
    reporter.finish({ id, phase: task.phase, retried: false });
    return;
  }
  transition(task, phase as Phase, {
    testExit: testExitRaw === undefined ? undefined : Number(testExitRaw),
  });
  writeTask(cwd, task);
  reporter.success(`${id} phase=${task.phase}`);
  reporter.finish({ id, phase: task.phase });
}

function cmdRedCheck(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("red-check", format, noColor);
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const res = redCheck(cwd, id);
  if (!res.ok) {
    fail(
      `red-check: oracle exited 0 while task ${id} is RED — the oracle does not discriminate; fix the spec's oracle before implementing`,
    );
  }
  reporter.success(
    `red-check: oracle failed as required (exit ${res.exitCode}) — recorded oracle_red`,
  );
  reporter.finish({ id, exitCode: res.exitCode });
}

function cmdVerify(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "verify";
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const reporter = makeReporter("verify", format, noColor);
  reporter.progress(`running oracle for ${id}...`);
  const res = verifyTask(cwd, id, {
    model: flag(args, "--model") ?? null,
    harness: flag(args, "--harness"),
    pluginVersion: sddxVersion(),
  });
  if (res.verdict === "pass") {
    const integration = res.integration ?? { result: "none" };
    reporter.success(
      `verdict=pass receipt=${res.receiptPath} commit=${res.commitSha} duration_ms=${res.durationMs}`,
    );
    if (integration.result === "merged") {
      reporter.success(
        `integrated: merged into ${integration.runBranch} (${integration.mergeCommit})`,
      );
    } else if (integration.result === "conflict") {
      reporter.error(
        `integration conflict: ${id} passed its oracle but could not be merged into ${integration.runBranch} — resolve manually`,
        { stream: "stdout" },
      );
    } else if (integration.reason === "no-branch") {
      reporter.error(
        `warning: ${id} belongs to goal (run branch ${integration.runBranch}) but records no branch of its own — it can never be merged into the run branch. This shape is only produced by sddx 3.x in-place mode; see docs/how-to/migrate-to-v4.md`,
        { stream: "stdout" },
      );
    }
    reporter.finish({
      id,
      verdict: "pass",
      receiptPath: res.receiptPath,
      commitSha: res.commitSha,
      durationMs: res.durationMs,
      exitCode: res.exitCode,
      integration,
    });
    return;
  }
  const iterations = readTask(cwd, id).iterations;
  reporter.error(
    `verdict=fail oracle_exit=${res.exitCode} duration_ms=${res.durationMs} iterations=${iterations}`,
  );
  reporter.finish(
    {
      id,
      verdict: "fail",
      receiptPath: null,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      iterations,
    },
    { status: "error" },
  );
  process.exit(1);
}

function cmdCleanup(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("cleanup", format, noColor);
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const branch = `sddx/${id}`;
  const wtPath = join(worktreesDir(cwd), id);
  if (existsSync(wtPath)) {
    if (isDirty(wtPath)) {
      fail(`refusing: worktree ${join(".sddx-worktrees", id)} has uncommitted changes`);
    }
    removeWorktree(cwd, wtPath);
    reporter.success(`removed worktree ${join(".sddx-worktrees", id)}`);
  }
  if (!branchExists(cwd, branch)) {
    reporter.success(`no branch ${branch} — nothing to clean up`);
    reporter.finish({ id, branch, removed: false });
    return;
  }
  if (currentBranch(cwd) === branch) {
    fail(`refusing: ${branch} is checked out — switch branches first`);
  }
  if (!isMerged(cwd, branch)) {
    // Ancestry into HEAD fails for a task not merged into the current
    // checkout even when it genuinely merged into its goal's run branch. Raw
    // ancestry into the run branch isn't the right proof either: a follow-up
    // bookkeeping commit on the task's own branch (recording its integration
    // result) advances the branch past what was actually merged, and a
    // reverted merge would still show as an ancestor forever after. The
    // goal's own `merges` log — sddx's bookkeeping, not a self-reported task
    // marker — is the authoritative, revert-aware answer to "is this task's
    // work currently part of the run branch."
    const goal = findGoalForTask(cwd, id);
    if (!goal || !currentlyMergedTaskIds(goal).includes(id)) {
      fail(`refusing: ${branch} is not merged into HEAD`);
    }
    reporter.success(
      `${branch} not merged into HEAD but merged into run branch ${goal.run_branch}`,
    );
    forceDeleteBranch(cwd, branch);
    reporter.success(`deleted branch ${branch} (merged via run branch)`);
    reporter.finish({ id, branch, removed: true, viaRunBranch: true });
    return;
  }
  deleteBranch(cwd, branch);
  reporter.success(`deleted merged branch ${branch}`);
  reporter.finish({ id, branch, removed: true, viaRunBranch: false });
}

function cmdPrCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("pr create", format, noColor);
  const goalIdArg = flag(args, "--goal");
  if (!goalIdArg) fail(USAGE, 2);
  const res = createGoalPr(cwd, goalIdArg, { title: flag(args, "--title") });
  reporter.success(`pr=${res.prUrl} branch=${res.branch} tasks=[${res.taskIds.join(", ")}]`);
  reporter.finish({ prUrl: res.prUrl, branch: res.branch, taskIds: res.taskIds });
}

function cmdRunReport(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("run report", format, noColor);
  const goalIdArg = flag(args, "--goal");
  if (!goalIdArg) fail(USAGE, 2);
  const report = generateRunReport(cwd, goalIdArg, defaultBranch(cwd));
  reporter.success(renderRunReport(report));
  reporter.finish(report);
}

function cmdSweep(cwd: string, format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("sweep", format, noColor);
  const res = sweep(cwd);
  if (res.locked) {
    reporter.success("sweep: another sweep holds the lock — skipped");
    reporter.finish({ locked: true, removed: [], skipped: [] });
    return;
  }
  for (const path of res.removed) reporter.success(`swept ${path}`);
  for (const s of res.skipped) reporter.success(`skipped ${s.path} (${s.reason})`);
  reporter.success(`sweep: ${res.removed.length} removed, ${res.skipped.length} skipped`);
  reporter.finish({ locked: false, removed: res.removed, skipped: res.skipped });
}

/** The run-scoped variant (`--goal <id>`): same shape as the per-task menu
 * below, but keyed to a goal's run branch instead of `cwd`'s current branch —
 * see `detectRunState`/`runActions`. */
function cmdNextActionsRun(
  cwd: string,
  goalArg: string,
  selectArg: string | undefined,
  reporter: Reporter,
): void {
  if (selectArg === undefined) {
    const visible = runActions(cwd, detectRunState(cwd, goalArg));
    reporter.success(renderMenu(visible));
    reporter.finish({ selected: null, nextActions: visible.map((a) => a.label) });
    return;
  }

  // state re-detected here too — see the matching comment on the per-task path
  const fresh = detectRunState(cwd, goalArg);
  const freshVisible = runActions(cwd, fresh);
  const resolved = resolveSelection(selectArg, freshVisible);
  if ("error" in resolved) {
    reporter.error(
      resolved.error === "ambiguous"
        ? `"${selectArg}" matches more than one action — be more specific.`
        : `"${selectArg}" isn't a valid action right now.`,
      { stream: "stdout" },
    );
    reporter.success(renderMenu(freshVisible));
    process.exitCode = 1;
    reporter.finish({ selected: selectArg, error: resolved.error }, { status: "error" });
    return;
  }
  if (!resolved.run) {
    reporter.error(`${resolved.label}: not implemented yet.`, { stream: "stdout" });
    process.exitCode = 1;
    reporter.finish({ selected: resolved.label, implemented: false }, { status: "error" });
    return;
  }
  const result = resolved.run(cwd, { branch: fresh.runBranch });
  if (result.ok) {
    reporter.success(result.message);
  } else {
    reporter.error(result.message, { stream: "stdout" });
    process.exitCode = 1;
  }
  reporter.finish(
    { selected: resolved.label, ok: result.ok },
    { status: result.ok ? "success" : "error" },
  );
}

function cmdNextActions(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("next-actions", format, noColor);
  const selectArg = flag(args, "--select");
  const goalArg = flag(args, "--goal");
  // Goal-scoped only. The current-branch variant answered a question about the
  // checkout rather than about the run, and could offer actions before the run
  // reached its single handoff point.
  if (!goalArg) {
    failWith(
      [
        "next-actions: --goal <goal-id> is required.",
        "The handoff is goal-scoped: it is shown once, after the run summary.",
        "Find the goal id with: sddx board",
      ],
      2,
    );
  }
  cmdNextActionsRun(cwd, goalArg, selectArg, reporter);
}

/** Env var consulted for each key that has one, in resolveConfig's precedence. */
const CONFIG_ENV_VAR_BY_KEY: Readonly<Record<string, string>> = {
  test_globs: "SDDX_TEST_GLOBS",
  exempt_globs: "SDDX_EXEMPT_GLOBS",
  board_enabled: "SDDX_BOARD_ENABLED",
  oracle_runs_default: "SDDX_ORACLE_RUNS",
  red_bash_allow: "SDDX_RED_BASH_ALLOW",
  stuck_threshold: "SDDX_STUCK_THRESHOLD",
};

function configValueSource(key: string, rawConfigHasKey: boolean): "env" | "config" | "default" {
  const envVar = CONFIG_ENV_VAR_BY_KEY[key];
  if (envVar && process.env[envVar] !== undefined) return "env";
  if (rawConfigHasKey) return "config";
  return "default";
}

function cmdConfigShow(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const legacyJson = args.includes("--json");
  if (legacyJson) printError("warning: --json is deprecated; use --output json instead");
  const effectiveFormat: OutputFormat = legacyJson ? "json" : format;
  const reporter = makeReporter("config show", effectiveFormat, noColor);
  const cfg = resolveConfig(cwd);

  const agentModel =
    Object.keys(cfg.agent_model).length > 0
      ? Object.entries(cfg.agent_model)
          .map(([role, model]) => `${role}=${model}`)
          .join(",")
      : "(none)";
  const lines = [
    `test_globs: ${cfg.test_globs || "(empty)"}`,
    `exempt_globs: ${cfg.exempt_globs || "(empty)"}`,
    `max_iterations_default: ${cfg.max_iterations_default}`,
    `board_enabled: ${cfg.board_enabled}`,
    `oracle_runs_default: ${cfg.oracle_runs_default}`,
    `red_bash_allow: ${cfg.red_bash_allow || "(empty)"}`,
    `stuck_threshold: ${cfg.stuck_threshold}`,
    `pr_host: ${cfg.pr_host ?? "(auto-detected from origin remote)"}`,
    `agent_model: ${agentModel}`,
    `verbose: ${cfg.verbose}`,
    `interaction_mode: ${cfg.interaction_mode}`,
    `auto_max_tasks: ${cfg.auto_max_tasks}`,
    `runtime_scope: ${cfg.runtime_scope}`,
    `package_manager: ${cfg.package_manager}`,
    `adapters: ${cfg.adapters.length > 0 ? cfg.adapters.join(",") : "(none)"}`,
    `schema_version: ${cfg.schema_version ?? "(unset — predates sddx init)"}`,
  ];
  reporter.success(lines.join("\n"));

  // verbose only affects terminal output (per docs/cli.md) — json/markdown
  // already carry every key, fully resolved, under `data`
  if (cfg.verbose && effectiveFormat === "terminal") {
    // name which source (env var / .sddx/config.json / built-in default)
    // actually won for each key — real diagnostic detail, not just the
    // resolved value the plain lines above already show.
    const raw = readConfig(cwd) as unknown as Record<string, unknown>;
    const detail = ["", "resolution detail (verbose):"];
    for (const key of Object.keys(cfg)) {
      detail.push(`  ${key}: source=${configValueSource(key, key in raw)}`);
    }
    reporter.success(detail.join("\n"));
  }
  reporter.finish(cfg);
}

/** The adapters sddx implements, by name. */
const ADAPTERS: Record<string, Adapter> = { claude: claudeAdapter };

/** Builds the generation context from committed policy — never from the machine. */
function adapterContext(root: string, override?: Partial<AdapterContext>): AdapterContext {
  const cfg = resolveConfig(root);
  return {
    runtimeScope: cfg.runtime_scope,
    packageManager: cfg.package_manager,
    invocation: sddxCommand(cfg.runtime_scope, cfg.package_manager),
    sddxVersion: sddxVersion(),
    ...override,
  };
}

function requireAdapter(name: string | undefined): Adapter {
  if (name === undefined)
    fail(`--adapter requires a value (one of ${Object.keys(ADAPTERS).join(", ")})`, 2);
  const adapter = ADAPTERS[name];
  if (!adapter) {
    fail(`unknown adapter "${name}" — known adapters: ${Object.keys(ADAPTERS).join(", ")}`, 2);
  }
  return adapter;
}

/**
 * `sddx sync --adapter <name>` — bring generated files back in step with the
 * committed policy, previewing every change first and writing only what the
 * ownership manifest proves sddx owns.
 */
function cmdSync(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "sync";
  const adapter = requireAdapter(flag(args, "--adapter"));
  const root = repositoryRoot(cwd);
  const ctx = adapterContext(root);
  const reporter = makeReporter("sync", format, noColor);

  const plan = planAdapter(root, adapter, ctx);
  const changing = plan.dispositions.filter((d) => d.kind === "create" || d.kind === "update");

  for (const d of plan.dispositions) {
    if (d.kind === "conflict") reporter.warn(`conflict  ${d.path} — ${d.reason}`);
    else if (d.kind !== "unchanged") reporter.success(`${d.kind.padEnd(9)} ${d.path}`);
  }

  if (planHasConflicts(plan)) {
    failWith(new AdapterConflictError(plan.conflicts).message.split("\n"), 3, { plan });
  }
  if (changing.length === 0) {
    reporter.success(`${adapter.name}: already up to date`);
    reporter.finish({ adapter: adapter.name, changed: [] });
    return;
  }
  if (!args.includes("--yes")) {
    reporter.success(`${changing.length} file(s) would change — re-run with --yes to apply`);
    reporter.finish({
      adapter: adapter.name,
      changed: changing.map((d) => d.path),
      applied: false,
    });
    return;
  }

  const result = applyAdapter(root, adapter, ctx, { force: args.includes("--force") });
  reporter.success(`${adapter.name}: updated ${result.written.length} file(s)`);
  reporter.finish({ adapter: adapter.name, changed: result.written, applied: true });
}

/**
 * `sddx doctor` — read-only diagnosis with an exact fix per failure.
 *
 * Runs outside an initialized repository, and outside a repository at all: the
 * moment a user most needs it is when nothing is set up correctly, so every
 * check degrades to a reportable state rather than throwing.
 */
function cmdDoctor(cwd: string, format: OutputFormat, noColor: boolean): void {
  currentCommand = "doctor";
  const reporter = makeReporter("doctor", format, noColor);

  let root: string | null = null;
  try {
    root = repositoryRoot(cwd);
  } catch {
    root = null;
  }

  const config = root === null ? null : resolveConfig(root);
  const report = runDoctor({
    cwd,
    root,
    config,
    adapters: ADAPTERS,
    adapterContext: root === null ? null : adapterContext(root),
    runningVersion: sddxVersion(),
  });

  for (const check of report.checks) {
    const line = `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}`;
    if (check.status === "fail") reporter.error(line);
    else if (check.status === "warn") reporter.warn(line);
    else reporter.success(line);
    if (check.fix) reporter.success(`     fix: ${check.fix}`);
  }

  const failures = report.checks.filter((c) => c.status === "fail").length;
  const warnings = report.checks.filter((c) => c.status === "warn").length;
  reporter.success(`${report.checks.length} check(s): ${failures} failed, ${warnings} warning(s)`);
  reporter.finish(report, report.failed ? { status: "error" } : {});
  if (report.failed) process.exit(1);
}

/** `sddx uninstall --adapter <name>` — remove only manifest-owned artifacts. */
function cmdUninstall(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "uninstall";
  const adapter = requireAdapter(flag(args, "--adapter"));
  const root = repositoryRoot(cwd);
  const reporter = makeReporter("uninstall", format, noColor);

  const result = uninstallAdapter(root, adapter, adapterContext(root));
  for (const p of result.removed) reporter.success(`removed   ${p}`);
  for (const p of result.keptModified) {
    reporter.warn(
      `kept      ${p} — modified after sddx wrote it, remove it by hand if you meant to`,
    );
  }
  reporter.success(
    `${adapter.name}: removed ${result.removed.length} path(s), kept ${result.keptModified.length} modified`,
  );
  reporter.finish(result);
}

/**
 * The adapter files an `init` would write, folded into its change plan.
 *
 * Generation reads the policy being proposed, not the policy on disk — during a
 * first `init` there is no `.sddx/config.json` yet, and a preview computed from
 * a default would show files that differ from the ones actually written.
 */
function adapterPlanFiles(root: string, opts: InitOptions): FileOp[] {
  const files: FileOp[] = [];
  const ctx: AdapterContext = {
    runtimeScope: opts.runtimeScope,
    packageManager: opts.packageManager,
    invocation: sddxCommand(opts.runtimeScope, opts.packageManager),
    sddxVersion: sddxVersion(),
  };
  for (const name of opts.adapters) {
    const adapter = ADAPTERS[name];
    if (!adapter) continue;
    for (const d of planAdapter(root, adapter, ctx).dispositions) {
      if (d.kind === "unchanged") {
        files.push({ path: d.path, kind: "unchanged", reason: `${name} adapter` });
      } else if (d.kind === "conflict") {
        // Surfaced in the preview as a modification the apply will refuse, so
        // the user sees it before confirming rather than after.
        files.push({
          path: d.path,
          kind: "modify",
          reason: `${name} adapter — CONFLICT: ${d.reason}`,
        });
      } else {
        // Deliberately no `contents`: these entries exist to be PREVIEWED. The
        // adapter applier writes them (and records ownership); a FileOp with
        // contents would have the generic file loop write them first, leaving
        // files on disk that no manifest accounts for.
        files.push({
          path: d.path,
          kind: d.kind === "create" ? "create" : "modify",
          reason: `${name} adapter`,
        });
      }
    }
  }
  return files;
}

/** One choice `init` needs, and the flag that supplies it non-interactively. */
interface InitChoice<T> {
  flag: string;
  values: readonly T[];
}

const RUNTIME_CHOICE: InitChoice<RuntimeScope> = { flag: "--runtime", values: RUNTIME_SCOPES };
const PM_CHOICE: InitChoice<PackageManager> = {
  flag: "--package-manager",
  values: PACKAGE_MANAGERS,
};
const MODE_CHOICE: InitChoice<InteractionMode> = {
  flag: "--interaction-mode",
  values: INTERACTION_MODES,
};

function choice<T extends string>(args: string[], spec: InitChoice<T>): T | undefined {
  const raw = flag(args, spec.flag);
  if (raw === undefined) return undefined;
  if (!(spec.values as readonly string[]).includes(raw)) {
    fail(`${spec.flag} must be one of ${spec.values.join("|")} — got "${raw}"`, 2);
  }
  return raw as T;
}

/** `--adapter` is repeatable: `--adapter claude --adapter other`. */
function adapterFlags(args: string[]): string[] {
  const adapters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--adapter") {
      const v = args[i + 1];
      if (v === undefined) fail("--adapter requires a value", 2);
      adapters.push(v as string);
    }
  }
  return [...new Set(adapters)];
}

const KNOWN_ADAPTERS = ["claude"] as const;

/**
 * Renders a plan as the preview a user approves. Every file, every command,
 * every config value — a preview that omitted one would be worse than none,
 * because it would be trusted.
 */
function renderInitPlan(plan: InitPlan): string {
  const lines: string[] = [];
  const changing = plan.files.filter((f) => f.kind !== "unchanged");
  lines.push(`repository: ${plan.root}`, "");

  lines.push("files:");
  if (changing.length === 0) {
    lines.push("  (none — everything is already in place)");
  } else {
    for (const f of changing) lines.push(`  ${f.kind.padEnd(6)} ${f.path}    # ${f.reason}`);
  }
  const unchanged = plan.files.length - changing.length;
  if (unchanged > 0) lines.push(`  (${unchanged} already up to date)`);

  lines.push("", "package manager:");
  if (plan.packageOps.length === 0) {
    lines.push("  (nothing to run)");
  } else {
    for (const op of plan.packageOps) lines.push(`  ${op.command.join(" ")}    # ${op.reason}`);
  }

  lines.push("", "config (.sddx/config.json):");
  for (const [key, value] of Object.entries(plan.config)) {
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/**
 * `sddx init` — non-interactive core.
 *
 * On a non-TTY this refuses rather than waiting: a CI run that blocks on a
 * prompt looks identical to a hang, and the flags that would have made it
 * deterministic are named in the error.
 */
function cmdInit(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "init";
  const dryRun = args.includes("--dry-run");
  const assumeYes = args.includes("--yes");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !assumeYes;

  const runtimeScope = choice(args, RUNTIME_CHOICE);
  const packageManager = choice(args, PM_CHOICE);
  const interactionMode = choice(args, MODE_CHOICE);
  const adapters = adapterFlags(args);
  for (const a of adapters) {
    if (!(KNOWN_ADAPTERS as readonly string[]).includes(a)) {
      failWith(
        [
          `unknown adapter "${a}" — known adapters: ${KNOWN_ADAPTERS.join(", ")}`,
          "An adapter sddx does not implement cannot be installed, synced, or removed safely.",
        ],
        2,
      );
    }
  }

  if (!interactive && runtimeScope === undefined && !dryRun) {
    failWith(
      [
        "sddx init needs its choices as flags when stdin/stdout is not an interactive terminal.",
        "Required: --runtime <global|project>",
        "Optional: --package-manager <npm|bun> (project scope), --adapter <name> (repeatable), --interaction-mode <human|auto>",
        "Add --yes to skip the confirmation, or --dry-run to preview without writing.",
        "Example: sddx init --yes --runtime global --adapter claude",
      ],
      2,
    );
  }

  const opts: InitOptions = {
    runtimeScope: runtimeScope ?? "global",
    packageManager: packageManager ?? "npm",
    adapters,
    interactionMode: interactionMode ?? "human",
  };

  const reporter = makeReporter("init", format, noColor);
  let plan: InitPlan;
  try {
    plan = planInit(cwd, opts, adapterPlanFiles);
  } catch (e) {
    if (e instanceof NotAGitRepositoryError) failWith(e.message.split("\n"), 1);
    throw e;
  }

  reporter.success(renderInitPlan(plan));

  if (dryRun) {
    reporter.success("dry run: nothing was written");
    reporter.finish({ plan, applied: false, dryRun: true });
    return;
  }

  if (planIsNoop(plan)) {
    reporter.success("already initialized — no changes");
    reporter.finish({ plan, applied: false, dryRun: false });
    return;
  }

  try {
    const result = applyInit(plan, {
      // Adapters run after the local files (so `.sddx/config.json` — the policy
      // generation reads — already exists) and before the package manager.
      runAdapters: (applied) => {
        const written: string[] = [];
        for (const name of opts.adapters) {
          const adapter = ADAPTERS[name] as Adapter;
          const ctx = adapterContext(applied.root);
          writeDeclaration(applied.root, name, {
            schema_version: ADAPTER_SCHEMA_VERSION,
            adapter: name,
          });
          written.push(declarationPath(name));
          written.push(...applyAdapter(applied.root, adapter, ctx).written);
        }
        return written;
      },
    });
    reporter.success(
      `initialized: ${result.written.length} file(s) written${
        result.packageOps.length > 0 ? `, ran ${result.packageOps.join(", ")}` : ""
      }`,
    );
    reporter.finish({ plan, applied: true, dryRun: false, result });
  } catch (e) {
    if (e instanceof InitApplyError) {
      failWith(
        [
          e.message,
          ...(e.rolledBack.length > 0
            ? ["rolled back:", ...e.rolledBack.map((s) => `  ${s}`)]
            : ["nothing had been written yet"]),
        ],
        1,
      );
    }
    throw e;
  }
}

function cmdConfigValidate(cwd: string, format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("config validate", format, noColor);
  const path = join(sddxDir(cwd), "config.json");
  if (!existsSync(path)) {
    reporter.success("config validate: no .sddx/config.json — using built-in defaults");
    reporter.finish({ hasConfig: false, warnings: [] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`config validate: .sddx/config.json is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("config validate: .sddx/config.json must be a JSON object");
  }
  const warnings = validateConfigObject(parsed as Record<string, unknown>);
  if (warnings.length === 0) {
    reporter.success("config validate: .sddx/config.json OK — no issues found");
  } else {
    for (const w of warnings) reporter.warn(`warning: ${w}`);
    reporter.success(`config validate: ${warnings.length} warning(s)`);
  }
  reporter.finish({ hasConfig: true, warnings });
}

/**
 * Validates an intake question batch. This exists as a command, rather than as
 * a line in the intake agent's prompt, because the three-question cap is an
 * acceptance criterion — and an acceptance criterion a model can talk its way
 * past is not one. The dispatching skill writes what intake returned and runs
 * this before rendering anything to the user.
 */
function cmdIntakeCheck(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("intake check", format, noColor);
  const path = flag(args, "--batch");
  if (!path) fail("intake check: --batch <path> is required");
  const abs = resolve(cwd, path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    // A batch that cannot be read must not pass as "no questions" — that would
    // send an unreviewed plan straight past the one round of questions.
    fail(`intake check: cannot read ${path}: ${(e as Error).message}`);
  }
  const { questions, errors } = parseQuestionBatch(text);
  if (!questions)
    failWith(
      errors.map((e) => `intake check: ${e}`),
      2,
    );
  reporter.success(
    `intake check: ${questions.length} question${questions.length === 1 ? "" : "s"} (cap ${QUESTION_CAP})`,
  );
  reporter.finish({ count: questions.length, cap: QUESTION_CAP, questions });
}

/**
 * Resolves a draft graph for Regenerate/Cancel: its absolute path, the spec
 * drafts it references, and the goal id it would materialize as. Both actions
 * are only ever legal while the plan is still a draft, so the goal check lives
 * here — once a goal record exists, branches, worktrees, and task state exist
 * with it, and neither action is a way to unwind those.
 */
function draftPlan(cwd: string, args: string[], action: string) {
  const graphArg = flag(args, "--graph");
  if (!graphArg) fail(`graph ${action}: --graph <path> is required`);
  const abs = resolve(cwd, graphArg);
  // Both actions DELETE (and Regenerate rewrites), and the path they act on
  // comes from a command line the agent composes plus `spec:` strings a draft
  // declares. Neither is a trusted path source: the Bash gate lets the sddx CLI
  // run in every phase, so without this an executor blocked from writing source
  // could still `graph cancel --graph src/index.ts` — or point a draft's `spec:`
  // at `../../src/index.ts` — and delete it, exit 0, "removed 1 draft". Drafts
  // live under `.sddx/drafts/` by construction, so refuse anything outside it.
  const drafts = draftsDir(cwd);
  if (!within(drafts, abs)) {
    fail(
      `graph ${action}: ${graphArg} is not under ${relative(cwd, drafts)}/ — ${action} only ever removes plan drafts, and refuses any path outside the drafts directory`,
      2,
    );
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    fail(`graph ${action}: cannot read ${graphArg}: ${(e as Error).message}`);
  }
  const { graph, errors } = parseGraph(text);
  // A header-only draft has nothing to regenerate but is still cancellable, so
  // an unparseable file is not fatal here — only a materialized one is.
  const goal = graph ? graph.goal : (/^goal:\s*(.+)$/m.exec(text)?.[1] ?? "").trim();
  const gid = goal === "" ? null : goalId(goal);
  // `goalExists` prefers the run-branch ref over a loose file, so this sees a
  // canonical goal as well as a legacy one. It deliberately does not PARSE the
  // record: a goal that exists but fails validation is still a materialized
  // run, and reading that as "still a draft" is how these actions came to delete
  // the artifacts an approval token and `plan_sha256` are bound to.
  if (gid !== null && goalExists(cwd, gid)) {
    fail(
      `graph ${action}: goal ${gid} has already been created from this plan — ${action} only applies while it is still a draft. Use cleanup/next-actions to unwind a materialized run.`,
      3,
    );
  }
  const specs = (graph?.tasks ?? []).map((n) => resolve(dirname(abs), n.spec));
  for (const spec of specs) {
    if (!within(drafts, spec)) {
      fail(
        `graph ${action}: ${relative(cwd, spec)} is outside ${relative(cwd, drafts)}/ — a node's spec path may not escape the drafts directory`,
        2,
      );
    }
  }
  return { graphArg, abs, text, graph, errors, specs, goalId: gid };
}

/**
 * Regenerate: discard the decomposition, keep the Goal Brief. The header is
 * truncated textually so every recorded answer survives byte-for-byte — the
 * user answered those questions once, and a re-plan is not a reason to ask
 * again. The orchestrator then runs afresh over the same header.
 */
function cmdGraphRegenerate(
  cwd: string,
  args: string[],
  format: OutputFormat,
  noColor: boolean,
): void {
  const reporter = makeReporter("graph regenerate", format, noColor);
  const { graphArg, abs, text, specs, goalId: gid } = draftPlan(cwd, args, "regenerate");
  const header = truncateToHeader(text);
  writeFileSync(abs, header);
  const removed: string[] = [];
  for (const spec of specs) {
    if (!existsSync(spec)) continue;
    rmSync(spec, { force: true });
    removed.push(relative(cwd, spec));
  }
  dropRenderCache(cwd, gid);
  reporter.success(
    [
      `graph regenerate: ${graphArg} truncated to its Goal Brief header — every recorded answer kept`,
      `removed ${removed.length} node spec draft${removed.length === 1 ? "" : "s"}`,
      "re-run the orchestrator over this header to produce a new decomposition",
    ].join("\n"),
  );
  reporter.finish({ graph: graphArg, removedSpecs: removed, headerBytes: header.length });
}

/** Cancel: remove the drafts and nothing else. No run has started, so there is
 * no branch, worktree, task, goal record, or token to unwind — which is the
 * whole reason the gate sits before materialization rather than after it. */
function cmdGraphCancel(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("graph cancel", format, noColor);
  const { graphArg, abs, specs, goalId: gid } = draftPlan(cwd, args, "cancel");
  const removed: string[] = [];
  for (const path of [...specs, abs]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(relative(cwd, path));
  }
  dropRenderCache(cwd, gid);
  reporter.success(
    `graph cancel: removed ${removed.length} draft${removed.length === 1 ? "" : "s"} for ${graphArg} — no branch, worktree, task, goal, or approval token existed to undo`,
  );
  reporter.finish({ removed });
}

function main(argv: string[]): void {
  const cwd = process.cwd();
  // `hook` speaks the harness's protocol — event JSON on stdin, decision JSON
  // on stdout, always exit 0 — not sddx's. It is intercepted ahead of output-
  // flag parsing and removed-flag rejection so nothing in the CLI's own
  // conventions can contaminate a decision the harness is waiting on.
  if (argv[0] === "hook") runHook(argv[1]);
  const { format, noColor, rest: cleaned } = parseOutputFlag(argv);
  // set before any dispatch so fail()/failWith() are format-aware even when
  // called from validation code that runs ahead of a command's own Reporter
  currentFormat = format;
  currentNoColor = noColor;
  const [cmd, ...rest] = cleaned;
  if (cmd === "--version" || cmd === "-v") {
    printLine(sddxVersion());
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    printLine(USAGE);
    return;
  }
  // Before dispatch, so every command answers the same way — a removed flag is
  // refused wherever it is typed, not only on the commands that once took it.
  rejectRemovedFlags(rest);
  try {
    // Removed in 4.0. Named rather than falling through to "unknown command",
    // because a user hitting this has a working muscle memory and needs the
    // replacement, not a usage dump. See docs/how-to/migrate-to-v4.md.
    if (cmd === "task" && rest[0] === "create") {
      failWith(
        [
          "`sddx task create` was removed: it produced a task with no goal and no run branch, outside the canonical lifecycle.",
          "Use a one-node graph instead — a single task is a one-node run:",
          "",
          "  goal: <one sentence>",
          "  tasks:",
          "    - alias: <name>",
          "      spec: <path-to-spec.yaml>",
          "",
          "then: sddx graph create --graph <path-to-graph.yaml>",
        ],
        2,
      );
    }
    if (cmd === "task" && rest[0] === "phase") {
      cmdTaskPhase(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "task" && rest[0] === "allow") {
      currentCommand = "task allow";
      const [id, path] = rest.slice(1);
      if (!id || !path) fail(USAGE, 2);
      // Absolute invariant, not a configurable threshold: the allow-list is the
      // only escape hatch from the TDD gate, so an unattended run that could
      // widen it would have no gate at all. Granting one needs a human in both
      // modes — auto mode has no way to ask, so it is simply refused.
      // Resolved through the git common dir, not the process cwd: `task allow`
      // is run BY the executor, from inside its own worktree, and
      // `.sddx/config.json` is not committed — so a worktree forked from
      // origin/HEAD has no copy of it. Reading it from there returned `{}`,
      // which resolves to `human`, which silently granted the exemption on
      // exactly the unattended runs this refusal exists to stop. Same fix
      // verify.ts already needed for reading the goal file.
      if (gateInteractionMode(resolveMainRepoRoot(cwd)) === "auto") {
        fail(
          `task allow: refused in auto mode — a TDD-gate exemption always requires a human. Mode is read from reviewed configuration only: set "interaction_mode": "human" in .sddx/config.json to grant "${path}" on ${id}.`,
        );
      }
      const task = readTask(cwd, id);
      allowPath(task, path);
      writeTask(cwd, task);
      const reporter = makeReporter("task allow", format, noColor);
      reporter.success(`${id} allow=[${task.allow.join(", ")}]`);
      reporter.finish({ id, allow: task.allow });
      return;
    }
    if (cmd === "task" && rest[0] === "show") {
      currentCommand = "task show";
      if (!rest[1]) fail(USAGE, 2);
      const task = readTask(cwd, rest[1]);
      const reporter = makeReporter("task show", format, noColor);
      // printed raw (not via reporter.success) so terminal mode never wraps the
      // JSON in a marker/ANSI color — a `✓ ` prefix or escape codes would make
      // this invalid JSON for anyone piping/copying it, even on a TTY
      if (format === "terminal") printLine(JSON.stringify(task, null, 2));
      else reporter.success(`task ${rest[1]}`);
      reporter.finish(task);
      return;
    }
    if (cmd === "task" && rest[0] === "materialize") {
      currentCommand = "task materialize";
      if (!rest[1]) fail(USAGE, 2);
      const { path, baseSha, mode } = materializeDependent(cwd, rest[1]);
      const where = path ? `worktree=${relative(cwd, path)}` : `branch=sddx/${rest[1]}`;
      const reporter = makeReporter("task materialize", format, noColor);
      reporter.success(`materialized ${rest[1]} ${mode} ${where} base=${baseSha}`);
      reporter.finish({ id: rest[1], mode, baseSha, path: path ? relative(cwd, path) : null });
      return;
    }
    if (cmd === "red-check") {
      cmdRedCheck(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "verify") {
      cmdVerify(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "board") {
      const res = computeBoard(cwd);
      const reporter = makeReporter("board", format, noColor);
      reporter.success(`${res.path}${res.changed ? "" : " (unchanged)"}`);
      reporter.finish(res.data);
      return;
    }
    if (cmd === "audit") {
      currentCommand = "audit";
      const unknown = rest.filter((a) => a !== "--signatures" && a !== "--ci");
      if (unknown.length > 0) fail(USAGE, 2);
      const withSignatures = rest.includes("--signatures");
      const reporter = makeReporter("audit", format, noColor);
      reporter.progress(
        `auditing receipts${withSignatures ? " (with signature verification)" : ""}...`,
      );
      const res = auditReceipts(cwd, { signatures: withSignatures, ci: rest.includes("--ci") });
      if (withSignatures) for (const n of res.notes) reporter.success(n);
      for (const f of res.findings) reporter.error(f);
      if (res.findings.length > 0) {
        reporter.error(`audit: ${res.findings.length} finding(s)`);
        reporter.finish(
          { receipts: res.receipts, findings: res.findings, notes: res.notes },
          { status: "error" },
        );
        process.exit(1);
      }
      reporter.success(`audit: ${res.receipts} receipt(s) verified, chain intact`);
      reporter.finish({ receipts: res.receipts, findings: [], notes: res.notes });
      return;
    }
    // Removed in 4.0 — see the `task create` note above.
    if (cmd === "goal" && rest[0] === "create") {
      failWith(
        [
          "`sddx goal create` was removed: it assembled already-created tasks into a goal after execution had begun, producing a run branch that did not exist when those tasks started.",
          "Goals are materialized before their tasks. `sddx graph create --graph <path>` creates the run branch first, then every task's workspace, and registers the goal with its dependency edges atomically.",
        ],
        2,
      );
    }
    if (cmd === "goal" && rest[0] === "show") {
      currentCommand = "goal show";
      if (!rest[1]) fail(USAGE, 2);
      const goal = readGoal(cwd, rest[1]);
      const reporter = makeReporter("goal show", format, noColor);
      // printed raw — see the matching comment on `task show` above
      if (format === "terminal") printLine(JSON.stringify(goal, null, 2));
      else reporter.success(`goal ${rest[1]}`);
      reporter.finish(goal);
      return;
    }
    if (cmd === "intake" && rest[0] === "check") {
      cmdIntakeCheck(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "graph" && rest[0] === "approve") {
      cmdGraphApprove(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "graph" && rest[0] === "create") {
      cmdGraphCreate(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "graph" && rest[0] === "regenerate") {
      cmdGraphRegenerate(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "graph" && rest[0] === "cancel") {
      cmdGraphCancel(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "pr" && rest[0] === "create") {
      cmdPrCreate(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "run" && rest[0] === "report") {
      cmdRunReport(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "cleanup") {
      cmdCleanup(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "sweep") {
      cmdSweep(cwd, format, noColor);
      return;
    }
    if (cmd === "next-actions") {
      cmdNextActions(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "hook") {
      // Never reached in practice: `hook` is intercepted before flag parsing
      // (see main()). Kept so an unrouted call still behaves.
      runHook(rest[0]);
    }
    if (cmd === "init") {
      cmdInit(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "doctor") {
      cmdDoctor(cwd, format, noColor);
      return;
    }
    if (cmd === "sync") {
      cmdSync(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "uninstall") {
      cmdUninstall(cwd, rest, format, noColor);
      return;
    }
    if (cmd === "config" && rest[0] === "show") {
      cmdConfigShow(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "config" && rest[0] === "validate") {
      cmdConfigValidate(cwd, format, noColor);
      return;
    }
    fail(USAGE, 2);
  } catch (e) {
    fail((e as Error).message);
  }
}

main(process.argv.slice(2));
