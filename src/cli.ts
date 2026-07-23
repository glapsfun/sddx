import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { auditReceipts } from "./audit";
import { computeBoard } from "./board";
import { readConfig, resolveConfig, validateConfigObject } from "./lib/config";
import {
  branchExists,
  commit,
  createBranch,
  currentBranch,
  deleteBranch,
  forceDeleteBranch,
  headSha,
  isMerged,
  stagePath,
} from "./lib/git";
import { createGoal, goalPath, readGoal } from "./lib/goal";
import { type GraphNode, parseGraph, validateSchedule } from "./lib/graph";
import { detectState, renderMenu, resolveSelection, visibleActions } from "./lib/next-actions";
import { type OutputFormat, parseOutputFlag, printError, printLine, Reporter } from "./lib/output";
import { createGoalPr } from "./lib/pr";
import { redCheck } from "./lib/redcheck";
import { parseSpec, type Spec } from "./lib/spec";
import {
  abandonOrRetry,
  allowPath,
  createTask,
  dependsOnList,
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
  hasSubmodules,
  isDirty,
  materializeDependent,
  removeWorktree,
  resolveBaseRef,
  retryWorkspace,
  sweep,
  worktreeAvailable,
  worktreesDir,
} from "./lib/worktree";

const USAGE = `usage:
  sddx task create --spec <path> [--workspace auto|worktree|branch|none] [--no-branch] [--depends-on <id>]...
  sddx task phase <id> <PHASE> [--test-exit <n>]
  sddx task allow <id> <path>
  sddx task show <id>
  sddx task materialize <id>
  sddx red-check <id>
  sddx verify <id> [--model <m>] [--harness <h>]
  sddx goal create --goal <sentence> --tasks <id1,id2,...>
  sddx goal show <id>
  sddx graph create --graph <path> [--workspace auto|worktree|branch|none]
  sddx pr create --goal <goal-id> [--title <title>]
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
  sddx next-actions [--select <reply>]
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
function failWith(messages: string[], code: 1 | 2 = 1): never {
  if (currentFormat === "terminal") {
    for (const m of messages) printError(m);
  } else {
    const reporter = makeReporter(currentCommand, currentFormat, currentNoColor);
    for (const m of messages) reporter.error(m);
    reporter.finish(null, { status: "error" });
  }
  process.exit(code);
}

function fail(message: string, code: 1 | 2 = 1): never {
  failWith([message], code);
}

function makeReporter(command: string, format: OutputFormat, noColor: boolean): Reporter {
  currentFormat = format;
  currentNoColor = noColor;
  currentCommand = command;
  return new Reporter(command, format, {
    noColor,
    pluginVersion: pluginVersion(),
    harness: "claude-code",
  });
}

/** Task ids with a state file in the main checkout's `.sddx/tasks/` (deferred and
 * branch/none-mode tasks live here; worktree tasks live in their worktrees). */
function mainTaskIds(cwd: string): string[] {
  const dir = join(sddxDir(cwd), "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} requires a value`, 2);
  return v;
}

/** Every occurrence of a repeatable flag, in order (e.g. multiple `--depends-on`). */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      if (v === undefined) fail(`${name} requires a value`, 2);
      out.push(v);
    }
  }
  return out;
}

function readVersionField(relativePath: string): string {
  try {
    const manifest = new URL(relativePath, import.meta.url);
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function pluginVersion(): string {
  return readVersionField("../.claude-plugin/plugin.json");
}

function packageVersion(): string {
  return readVersionField("../package.json");
}

const WORKSPACE_MODES = ["auto", "worktree", "branch", "none"] as const;
type WorkspaceFlag = (typeof WORKSPACE_MODES)[number];

function pickWorkspace(
  cwd: string,
  requested: WorkspaceFlag,
  reporter: Reporter,
): "worktree" | "branch" | "none" {
  if (requested !== "auto") return requested;
  if (!worktreeAvailable(cwd)) {
    reporter.success("git worktree unavailable → branch mode");
    return "branch";
  }
  const base = resolveBaseRef(cwd);
  if (hasSubmodules(cwd, base.sha)) {
    reporter.success("submodules detected → branch mode");
    return "branch";
  }
  return "worktree";
}

/** Create a root task with a real workspace (worktree/branch/none). `specSrc` is
 * the absolute path of the spec file to copy into the task's `.sddx/specs/`. */
function createRootTask(
  cwd: string,
  spec: Spec,
  specSrc: string,
  mode: "worktree" | "branch" | "none",
  reporter: Reporter,
): { id: string; line: string } {
  const id = taskId(spec.task);
  if (mode === "worktree") {
    const base = resolveBaseRef(cwd);
    if (base.source === "HEAD") reporter.success("no origin remote — forking from local HEAD");
    const wtPath = createWorktree(cwd, id, base.sha);
    const relPath = join(".sddx-worktrees", id);
    mkdirSync(join(sddxDir(wtPath), "specs"), { recursive: true });
    const specPath = join(".sddx", "specs", `${id}.yaml`);
    copyFileSync(specSrc, join(wtPath, specPath));
    createTask(wtPath, spec, specPath, {
      mode: "worktree",
      branch: `sddx/${id}`,
      base_sha: base.sha,
      path: relPath,
    });
    return {
      id,
      line: `created ${id} phase=PLAN worktree=${relPath} branch=sddx/${id} base=${base.sha}`,
    };
  }
  const useBranch = mode === "branch";
  const base = headSha(cwd);
  if (useBranch) createBranch(cwd, `sddx/${id}`);
  mkdirSync(join(sddxDir(cwd), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(specSrc, join(cwd, specPath));
  createTask(cwd, spec, specPath, {
    mode,
    branch: useBranch ? `sddx/${id}` : null,
    base_sha: base,
  });
  return { id, line: `created ${id} phase=PLAN branch=${useBranch ? `sddx/${id}` : "none"}` };
}

/** Create a deferred dependent task in the main checkout — no worktree yet, base
 * `pending:<parent-id>[,<parent-id>...]`. Materialized once every named parent
 * is DONE (single fork, or a sequential merge for fan-in — see worktree.ts). */
function createDeferredTask(
  cwd: string,
  spec: Spec,
  specSrc: string,
  mode: "worktree" | "branch" | "none",
  dependsOn: string[],
): string {
  // A dependent forks from its parent's DONE commit (the tip of `sddx/<parent>`).
  // `none` mode never creates that branch, so the dependent could never be
  // materialized — refuse it here rather than stranding an un-dispatchable task.
  if (mode === "none") {
    throw new Error(
      "dependent tasks require worktree or branch mode — `none` has no isolatable base to fork from",
    );
  }
  const id = taskId(spec.task);
  mkdirSync(join(sddxDir(cwd), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(specSrc, join(cwd, specPath));
  createTask(
    cwd,
    spec,
    specPath,
    { mode, branch: null, base_sha: `pending:${dependsOn.join(",")}` },
    { dependsOn },
  );
  return id;
}

function cmdTaskCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("task create", format, noColor);
  const specArg = flag(args, "--spec");
  if (!specArg) fail(USAGE, 2);
  const requested = (flag(args, "--workspace") ??
    (args.includes("--no-branch") ? "none" : "auto")) as WorkspaceFlag;
  if (!WORKSPACE_MODES.includes(requested)) fail(USAGE, 2);
  let yamlText: string;
  try {
    yamlText = readFileSync(join(cwd, specArg), "utf8");
  } catch {
    fail(`cannot read spec file: ${specArg}`);
  }
  const { spec, errors } = parseSpec(yamlText);
  if (!spec) {
    failWith(errors.map((e) => `spec error: ${e}`));
  }
  const mode = pickWorkspace(cwd, requested, reporter);
  const specSrc = join(cwd, specArg);

  // A dependent task cannot fork now — its parents' DONE commits do not exist
  // yet. Record it deferred (base `pending:<parent-id>[,...]`, no worktree); its
  // workspace is materialized once every named parent verifies.
  const dependsOn = flags(args, "--depends-on");
  if (dependsOn.length > 0) {
    for (const parentId of dependsOn) {
      if (!resolveTaskState(cwd, parentId)) fail(`--depends-on: no such task ${parentId}`);
    }
    // Apply the overlap ⟹ ordered gate against true siblings (tasks sharing at
    // least one parent — they may run concurrently), so an individually-created
    // dependent can't slip an overlapping sibling past the graph/goal gates.
    // The prospective task joins the sibling set for the check.
    const newId = taskId(spec.task);
    const siblings: Array<{ id: string; dependsOn: string[]; scope: string[] }> = [
      { id: newId, dependsOn, scope: spec.scope },
    ];
    for (const tid of mainTaskIds(cwd)) {
      const t = resolveTaskState(cwd, tid);
      if (t && t.id !== newId && dependsOnList(t).some((p) => dependsOn.includes(p))) {
        siblings.push({ id: t.id, dependsOn: dependsOnList(t), scope: t.scope ?? [] });
      }
    }
    const sibErrs = validateSchedule(siblings);
    if (sibErrs.length > 0) {
      failWith(sibErrs.map((e) => `task error: ${e}`));
    }
    const id = createDeferredTask(cwd, spec, specSrc, mode, dependsOn);
    reporter.success(
      `created ${id} phase=PLAN depends_on=${dependsOn.join(",")} workspace=deferred(${mode})`,
    );
    reporter.finish({ id, phase: "PLAN", dependsOn, workspace: "deferred", mode });
    return;
  }

  const { id, line } = createRootTask(cwd, spec, specSrc, mode, reporter);
  reporter.success(line);
  reporter.finish({ id, phase: "PLAN", mode });
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

function cmdGraphCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("graph create", format, noColor);
  const graphArg = flag(args, "--graph");
  if (!graphArg) fail(USAGE, 2);
  const requested = (flag(args, "--workspace") ?? "auto") as WorkspaceFlag;
  if (!WORKSPACE_MODES.includes(requested)) fail(USAGE, 2);
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
  // `none` mode can't isolate a dependent's base (no `sddx/<parent>` branch to
  // fork from), so a graph with any edge is incompatible with it — catch it here,
  // atomically, rather than mid-creation.
  if (requested === "none" && graph.tasks.some((n) => n.depends_on.length > 0)) {
    errs.push("workspace none is incompatible with dependent tasks — use worktree or branch mode");
  }
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
    loaded.set(node.alias, { spec, src });
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
  if (errs.length > 0) {
    failWith(errs.map((e) => `graph error: ${e}`));
  }

  // Gate passed — now create tasks in dependency order (roots create real
  // workspaces; dependents are deferred), then register the goal with its edges.
  const mode = pickWorkspace(cwd, requested, reporter);
  const aliasToId = new Map<string, string>();
  const deps: Record<string, string[]> = {};
  const created: string[] = [];
  for (const node of topoOrder(graph.tasks)) {
    const { spec, src } = loaded.get(node.alias) as { spec: Spec; src: string };
    if (node.depends_on.length === 0) {
      const { id, line } = createRootTask(cwd, spec, src, mode, reporter);
      aliasToId.set(node.alias, id);
      created.push(id);
      reporter.success(line);
    } else {
      const parentIds = node.depends_on.map((alias) => aliasToId.get(alias) as string);
      const id = createDeferredTask(cwd, spec, src, mode, parentIds);
      aliasToId.set(node.alias, id);
      created.push(id);
      deps[id] = parentIds;
      reporter.success(
        `created ${id} phase=PLAN depends_on=${parentIds.join(",")} workspace=deferred(${mode})`,
      );
    }
  }
  const g = createGoal(cwd, graph.goal, created, deps);
  stagePath(cwd, goalPath(cwd, g.id));
  commit(cwd, `sddx: register goal ${g.id}`);
  reporter.success(`created goal ${g.id} tasks=[${g.task_ids.join(", ")}]`);
  for (const [alias, id] of aliasToId) reporter.success(`  ${alias} → ${id}`);
  reporter.finish({ goalId: g.id, taskIds: g.task_ids, aliasToId: Object.fromEntries(aliasToId) });
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
    pluginVersion: pluginVersion(),
  });
  if (res.verdict === "pass") {
    reporter.success(
      `verdict=pass receipt=${res.receiptPath} commit=${res.commitSha} duration_ms=${res.durationMs}`,
    );
    reporter.finish({
      id,
      verdict: "pass",
      receiptPath: res.receiptPath,
      commitSha: res.commitSha,
      durationMs: res.durationMs,
      exitCode: res.exitCode,
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

/**
 * A task's `shipped` marker is self-reported, mutable JSON — not proof on its
 * own. Cross-check it against the goal file (which `pr create` stamps with
 * the same `pr_url` only after a real PR opened) so cleanup can't be tricked
 * into force-deleting a branch by a hand-edited or stale task file.
 */
function corroboratedShip(
  cwd: string,
  taskId: string,
  shipped: { goal_id: string; pr_url: string } | undefined,
): boolean {
  if (!shipped) return false;
  try {
    const goal = readGoal(cwd, shipped.goal_id);
    return goal.task_ids.includes(taskId) && goal.shipped?.pr_url === shipped.pr_url;
  } catch {
    return false;
  }
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
    // ancestry check fails for cherry-picked commits (new SHA, same diff) even
    // when the task genuinely shipped via `sddx pr create` — the shipped
    // marker on the task's own branch is the second, non-ancestry proof.
    const shipped = resolveTaskState(cwd, id)?.shipped;
    if (!shipped || !corroboratedShip(cwd, id, shipped)) {
      fail(`refusing: ${branch} is not merged into HEAD`);
    }
    reporter.success(
      `${branch} not merged by ancestry but shipped in goal ${shipped.goal_id} (${shipped.pr_url})`,
    );
    forceDeleteBranch(cwd, branch);
    reporter.success(`deleted shipped branch ${branch}`);
    reporter.finish({ id, branch, removed: true, shipped: true });
    return;
  }
  deleteBranch(cwd, branch);
  reporter.success(`deleted merged branch ${branch}`);
  reporter.finish({ id, branch, removed: true, shipped: false });
}

function cmdGoalCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("goal create", format, noColor);
  const goalSentence = flag(args, "--goal");
  const tasksArg = flag(args, "--tasks");
  if (!goalSentence || !tasksArg) fail(USAGE, 2);
  const taskIds = tasksArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  // Same overlap ⟹ ordered gate as `graph create`, over the listed tasks' own
  // depends_on/scope — so the single-task/`--solo` path can't register a goal
  // whose concurrent tasks would collide.
  const scheduleErrs = validateSchedule(
    taskIds.map((tid) => {
      const t = resolveTaskState(cwd, tid);
      return { id: tid, dependsOn: t ? dependsOnList(t) : [], scope: t?.scope ?? [] };
    }),
  );
  if (scheduleErrs.length > 0) {
    failWith(scheduleErrs.map((e) => `goal error: ${e}`));
  }
  const g = createGoal(cwd, goalSentence, taskIds);
  // committed narrowly (not `git add -A`) so registering a goal in the main
  // checkout never sweeps up unrelated work sitting there — G5: state is
  // files in git, and a goal is meaningless if it's only ever on disk
  stagePath(cwd, goalPath(cwd, g.id));
  commit(cwd, `sddx: register goal ${g.id}`);
  reporter.success(`created goal ${g.id} tasks=[${g.task_ids.join(", ")}]`);
  reporter.finish({ id: g.id, taskIds: g.task_ids });
}

function cmdPrCreate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("pr create", format, noColor);
  const goalIdArg = flag(args, "--goal");
  if (!goalIdArg) fail(USAGE, 2);
  const res = createGoalPr(cwd, goalIdArg, { title: flag(args, "--title") });
  reporter.success(`pr=${res.prUrl} branch=${res.branch} tasks=[${res.taskIds.join(", ")}]`);
  reporter.finish({ prUrl: res.prUrl, branch: res.branch, taskIds: res.taskIds });
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

function cmdNextActions(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("next-actions", format, noColor);
  const selectArg = flag(args, "--select");
  // detected fresh here, and again just before executing a selection — state
  // between "show the menu" and "act on a reply" spans a model turn, so it
  // can drift (the user may commit or push by hand outside sddx meanwhile)
  const detected = detectState(cwd);
  if (detected.warning) reporter.success(`warning: ${detected.warning}`);

  if (selectArg === undefined) {
    const visible = visibleActions(detected.state);
    reporter.success(renderMenu(visible));
    reporter.finish({ selected: null, nextActions: visible.map((a) => a.label) });
    return;
  }

  const fresh = detectState(cwd);
  const freshVisible = visibleActions(fresh.state);
  const resolved = resolveSelection(selectArg, freshVisible);
  if ("error" in resolved) {
    // stdout, matching next-actions' historical convention (exit code carries
    // the failure signal) — but recorded as a real `error` message so the
    // JSON/Markdown envelope's `errors` array isn't empty despite status "error"
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
  const result = resolved.run(cwd, { branch: fresh.branch });
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
    `workspace_mode: ${cfg.workspace_mode}`,
    `test_globs: ${cfg.test_globs || "(empty)"}`,
    `exempt_globs: ${cfg.exempt_globs || "(empty)"}`,
    `max_iterations_default: ${cfg.max_iterations_default}`,
    `board_enabled: ${cfg.board_enabled}`,
    `oracle_runs_default: ${cfg.oracle_runs_default}`,
    `red_bash_allow: ${cfg.red_bash_allow || "(empty)"}`,
    `stuck_threshold: ${cfg.stuck_threshold}`,
    `pr_host: ${cfg.pr_host ?? "(auto-detected from origin remote)"}`,
    `agent_model: ${agentModel}`,
    `prefer_solo: ${cfg.prefer_solo}`,
    `verbose: ${cfg.verbose}`,
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

function main(argv: string[]): void {
  const cwd = process.cwd();
  const { format, noColor, rest: cleaned } = parseOutputFlag(argv);
  // set before any dispatch so fail()/failWith() are format-aware even when
  // called from validation code that runs ahead of a command's own Reporter
  currentFormat = format;
  currentNoColor = noColor;
  const [cmd, ...rest] = cleaned;
  if (cmd === "--version" || cmd === "-v") {
    printLine(packageVersion());
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    printLine(USAGE);
    return;
  }
  try {
    if (cmd === "task" && rest[0] === "create") {
      cmdTaskCreate(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "task" && rest[0] === "phase") {
      cmdTaskPhase(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "task" && rest[0] === "allow") {
      currentCommand = "task allow";
      const [id, path] = rest.slice(1);
      if (!id || !path) fail(USAGE, 2);
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
    if (cmd === "goal" && rest[0] === "create") {
      cmdGoalCreate(cwd, rest.slice(1), format, noColor);
      return;
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
    if (cmd === "graph" && rest[0] === "create") {
      cmdGraphCreate(cwd, rest.slice(1), format, noColor);
      return;
    }
    if (cmd === "pr" && rest[0] === "create") {
      cmdPrCreate(cwd, rest.slice(1), format, noColor);
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
