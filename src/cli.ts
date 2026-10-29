import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditReceipts } from "./audit";
import { computeBoard } from "./board";
import { approvalPath, findApproval, writeApproval } from "./lib/approval";
import {
  gateInteractionMode,
  profile,
  readConfig,
  resolveConfig,
  validateConfigObject,
} from "./lib/config";
import { runDoctor } from "./lib/doctor";
import {
  branchExists,
  currentBranch,
  defaultBranch,
  deleteBranch,
  forceDeleteBranch,
  isMerged,
} from "./lib/git";
import { rememberProject } from "./lib/globalstate";
import { currentlyMergedTaskIds, findGoalForTask, readGoal } from "./lib/goal";
import { formatSpecError, type GoalSpec, parseGoalSpec } from "./lib/goalspec";
import { runHook } from "./lib/hookdispatch";
import { abandonTask, readyTasks, startTask } from "./lib/lifecycle";
import {
  applyMigration,
  detectV5State,
  inFlight,
  nothingToDo,
  planMigration,
  v5Blockers,
} from "./lib/migrate";
import { detectRunState, renderMenu, resolveSelection, runActions } from "./lib/next-actions";
import { type OutputFormat, parseOutputFlag, printError, printLine, Reporter } from "./lib/output";
import { decidePlanGate, resolvePlan, startPlan } from "./lib/plan";
import { createGoalPr } from "./lib/pr";
import { recordManualRun } from "./lib/recorder";
import { recordReview } from "./lib/review";
import { generateRunReport, renderRunReport } from "./lib/runreport";
import { shellWord } from "./lib/shellcwd";
import {
  allowPath,
  isTerminal,
  readTask,
  resolveTaskState,
  sddxDir,
  taskHome,
  writeTask,
} from "./lib/task";
import { verifyTask } from "./lib/verify";
import { isDirty, removeWorktree, resolveMainRepoRoot, sweep, worktreesDir } from "./lib/worktree";

const USAGE = `usage:
  sddx spec check <spec.md>
  sddx plan check <spec.md>
  sddx plan approve <spec.md> [--harness <name>]
  sddx plan start <spec.md>
  sddx task ready --goal <goal-id>
  sddx task start <id>
  sddx task abandon <id> --reason <text>
  sddx task show <id>
  sddx verify <id>
  sddx review record <id> --verdict <pass|fail> [--findings <file>] [--reviewer <name>]
                     [--harness <name>] [--model <name>]
  sddx goal show <goal-id>
  sddx run report --goal <goal-id>
  sddx pr create --goal <goal-id> [--title <title>]
  sddx next-actions --goal <goal-id> [--select <reply>]
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
  sddx config show
  sddx config validate
  sddx doctor
  sddx migrate [--yes]
strict profile only:
  sddx task phase <id> <RED|GREEN> --test-exit <n>
  sddx task allow <id> <path>
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

/**
 * The product version, and the only version source there is.
 *
 * Resolved relative to this module's own URL so it works identically from a
 * cloned checkout (`src/cli.ts` → `../package.json`) and from an installed
 * package (`dist/cli.mjs` → `../package.json`), including when a global install
 * reached the bundle through a symlinked `bin` entry.
 *
 * This value is what gets stamped into a receipt's `plugin_version` field. The
 * FIELD keeps its name: receipts are immutable and hash-chained, so renaming
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
    harness: process.env.SDDX_HARNESS ?? "unknown",
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
      failWith([`\`${flagName}\` was removed: ${why}`, "Drop the flag."], 2);
    }
  }
}

/**
 * Commands removed in sddx 6, each with what replaces it. Named rather than
 * falling through to the usage text, because a user typing one has working
 * muscle memory and needs the replacement.
 */
const REMOVED_COMMANDS: ReadonlyArray<{
  match: (cmd: string, sub?: string) => boolean;
  text: string;
}> = [
  {
    match: (c) => c === "init" || c === "sync" || c === "uninstall",
    text: "was removed in sddx 6: harness integration is installed by the sddx plugin (for Claude Code: /plugin install sddx), and the repository needs no setup. To clean up a sddx 5 install run: sddx migrate",
  },
  {
    match: (c) => c === "graph",
    text: "was removed in sddx 6: a goal is one markdown spec in .sddx/specs/. Use: sddx plan check <spec>, sddx plan approve <spec>, sddx plan start <spec>",
  },
  {
    match: (c) => c === "intake",
    text: "was removed in sddx 6: requirements are gathered by the brainstorm skill and checked with: sddx spec check <spec>",
  },
  {
    match: (c) => c === "red-check",
    text: "was removed in sddx 6: sddx verify <id> now proves the oracle fails without the change and passes with it",
  },
  {
    match: (c, s) => c === "task" && s === "materialize",
    text: "was removed in sddx 6: use sddx task start <id>",
  },
  {
    match: (c, s) => (c === "task" || c === "goal") && s === "create",
    text: "was removed: write a goal spec in .sddx/specs/ and run sddx plan start <spec>",
  },
];

/** Refuses to act on a repository sddx 5 still owns. */
function refuseOnV5State(cwd: string): void {
  let root: string;
  try {
    root = resolveMainRepoRoot(cwd);
  } catch {
    return;
  }
  const blockers = v5Blockers(detectV5State(root));
  if (blockers.length === 0) return;
  failWith([
    "this repository still holds sddx 5 state, which sddx 6 cannot act on:",
    ...blockers.map((b) => `  ${b}`),
    "Run `sddx migrate` to preview the move, then `sddx migrate --yes`.",
  ]);
}

function cmdPlanCheck(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("plan check", format, noColor);
  const specArg = args.find((a) => !a.startsWith("-"));
  if (!specArg) fail(USAGE, 2);
  const plan = resolvePlan(cwd, specArg);
  if (plan.errors.length > 0) {
    failWith(
      plan.errors.map((e) => `plan check: ${e}`),
      1,
      { specPath: plan.specPath, planSha256: plan.hash, errors: plan.errors },
    );
  }
  const spec = plan.spec as GoalSpec;
  const base = plan.base as NonNullable<typeof plan.base>;
  for (const n of plan.notices) reporter.success(n);
  const approved = findApproval(plan.root, plan.absPath).ok;
  const mode = gateInteractionMode(plan.root);
  reporter.success(`plan ${plan.hash} (${plan.specPath})`);
  reporter.success(`goal ${plan.goalId}: ${spec.title}`);
  reporter.success(`base ${base.sha} (${base.source}), run branch ${plan.runBranch}`);
  reporter.success(`${spec.tasks.length} task(s):`);
  for (const t of spec.tasks) {
    const deps = t.depends_on.length > 0 ? ` after ${t.depends_on.join(", ")}` : "";
    const scope = t.scope.length > 0 ? t.scope.join(", ") : "(unconfined)";
    reporter.success(
      `  ${t.id} ${t.title}${deps}; scope ${scope}; oracle ${t.oracle.run || t.oracle.type}`,
    );
  }
  reporter.success(
    `mode ${mode}; ${approved ? "approved" : `not approved (approve with: sddx plan approve ${specArg})`}`,
  );
  reporter.finish({
    specPath: plan.specPath,
    planSha256: plan.hash,
    goalId: plan.goalId,
    runBranch: plan.runBranch,
    baseSha: base.sha,
    baseSource: base.source,
    taskCount: spec.tasks.length,
    tasks: spec.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dependsOn: t.depends_on,
      scope: t.scope,
      oracle: t.oracle,
    })),
    mode,
    approved,
  });
}

function cmdPlanApprove(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("plan approve", format, noColor);
  const harness = flag(args, "--harness");
  const specArg = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--harness");
  if (!specArg) fail(USAGE, 2);
  // Codex sets CODEX_TOOL_CALL_ID on every command its agent runs, and never on
  // one the user types with `!`. This stops an agent that runs the command as
  // it is; one that clears the variable gets past it, which only the plugin's
  // trusted approval hook stops.
  if (process.env.CODEX_TOOL_CALL_ID) {
    const own = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sddx");
    failWith(
      [
        "plan approve: only a person can approve a plan, and this ran as a Codex agent's tool call",
        `ask the user to review the plan and type: !${shellWord(own)} plan approve ${shellWord(specArg)}`,
      ],
      3,
    );
  }
  const plan = resolvePlan(cwd, specArg);
  if (plan.errors.length > 0) failWith(plan.errors.map((e) => `plan approve: ${e}`));
  // The hard refusals run here too: approving a plan `auto` mode will refuse
  // anyway would tell a person who just approved it to approve it again.
  const gate = decidePlanGate(plan);
  if (gate.refusal) failWith([`plan approve: ${gate.refusal}`], 1, { blocker: gate.blocker });
  // A token always records `mode: human`: approving IS the deliberate act, so a
  // `mode: auto` receipt keeps meaning "no person saw this plan".
  const approval = writeApproval(plan.root, {
    plan_sha256: plan.hash,
    mode: "human",
    ...(harness ? { harness_reported: harness } : {}),
  });
  reporter.success(`approved plan ${plan.hash}`);
  reporter.success(`token: ${relative(cwd, approvalPath(plan.root, plan.hash))}`);
  if (approval.signature) reporter.success(`signed by ${approval.signer}`);
  reporter.finish({
    planSha256: plan.hash,
    tokenPath: approvalPath(plan.root, plan.hash),
    signed: Boolean(approval.signature),
    tasks: plan.spec?.tasks.length ?? 0,
  });
}

function cmdPlanStart(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("plan start", format, noColor);
  const specArg = args.find((a) => !a.startsWith("-"));
  if (!specArg) fail(USAGE, 2);
  const plan = resolvePlan(cwd, specArg);
  if (plan.errors.length > 0) failWith(plan.errors.map((e) => `plan start: ${e}`));
  const gate = decidePlanGate(plan);
  if (gate.refusal) failWith([`plan start: ${gate.refusal}`], 1, { blocker: gate.blocker });
  if (!gate.ok) {
    failWith(
      [
        `plan start: no approval on file for plan ${plan.hash}`,
        `review it with: sddx plan check ${specArg}`,
        `then approve it with: sddx plan approve ${specArg}`,
      ],
      3,
      { planSha256: plan.hash },
    );
  }
  for (const n of plan.notices) reporter.success(n);
  const started = startPlan(plan, gate);
  try {
    rememberProject(plan.root);
  } catch {
    // the user-global project index is a convenience, never a reason to fail
  }
  reporter.success(`started goal ${started.goalId} (mode ${gate.mode})`);
  reporter.success(
    `run branch ${started.runBranch} at ${started.planCommit} (plan commit on ${started.baseSha})`,
  );
  reporter.success(`tasks: ${started.taskIds.join(", ")}`);
  if (started.wroteConfig) reporter.success("wrote .sddx/config.json with defaults");
  reporter.finish({ ...started, mode: gate.mode, planSha256: plan.hash });
}

function cmdTaskStart(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("task start", format, noColor);
  const id = args[0];
  if (!id) fail(USAGE, 2);
  const s = startTask(cwd, id);
  reporter.success(`${id} IN_PROGRESS (profile ${s.task.profile})`);
  reporter.success(s.path);
  reporter.finish({
    id,
    path: s.path,
    branch: `sddx/${id}`,
    baseSha: s.baseSha,
    reused: s.reused,
    profile: s.task.profile,
  });
}

function cmdTaskReady(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("task ready", format, noColor);
  const goal = flag(args, "--goal");
  if (!goal) fail(USAGE, 2);
  const ids = readyTasks(cwd, goal);
  reporter.success(ids.length > 0 ? ids.join("\n") : "(no task can start right now)");
  reporter.finish({ goal, ready: ids });
}

function cmdTaskAbandon(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("task abandon", format, noColor);
  const id = args[0];
  const reason = flag(args, "--reason");
  if (!id || !reason) fail(USAGE, 2);
  const res = abandonTask(cwd, id, reason);
  if (res.retried) {
    reporter.success(`${id} retry ${res.attempt_count}/${res.max_attempts}: back to PLANNED`);
  } else {
    reporter.success(`${id} ABANDONED: ${reason}`);
    for (const s of res.skipped) reporter.success(`${s} ABANDONED: skipped`);
  }
  reporter.finish({
    id,
    phase: res.task.phase,
    retried: res.retried,
    attempt_count: res.attempt_count,
    max_attempts: res.max_attempts,
    skipped: res.skipped,
  });
}

/** `task phase` and `task allow` exist only for a repository using the strict profile. */
function requireStrict(cwd: string, command: string): string {
  const root = resolveMainRepoRoot(cwd);
  if (profile(root) !== "strict") {
    failWith(
      [
        `${command} exists only in the strict profile; this repository uses the default profile.`,
        'In the default profile, sddx verify proves the change. To opt in, set "profile": "strict" in .sddx/config.json.',
      ],
      2,
    );
  }
  return root;
}

function cmdTaskPhase(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const root = requireStrict(cwd, "sddx task phase");
  const reporter = makeReporter("task phase", format, noColor);
  const [id, phase] = args;
  const exitRaw = flag(args, "--test-exit");
  if (!id || (phase !== "RED" && phase !== "GREEN") || exitRaw === undefined) fail(USAGE, 2);
  const home = taskHome(root, id);
  if (!home) fail(`no such task: ${id}`);
  const task = readTask(home, id);
  recordManualRun(task, phase, Number(exitRaw));
  writeTask(home, task);
  reporter.success(`${id} recorded ${phase} (test exit ${exitRaw})`);
  reporter.finish({ id, strictPhase: phase });
}

function cmdTaskAllow(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const root = requireStrict(cwd, "sddx task allow");
  const [id, path] = args;
  if (!id || !path) fail(USAGE, 2);
  // The allow list is the only escape from the strict gate, so an unattended run
  // that could widen it would have no gate. It always needs a person.
  if (gateInteractionMode(root) === "auto") {
    fail(
      `task allow: refused in auto mode; a gate exemption always needs a person. Set "interaction_mode": "human" in .sddx/config.json to grant "${path}" on ${id}.`,
    );
  }
  const home = taskHome(root, id);
  if (!home) fail(`no such task: ${id}`);
  const task = readTask(home, id);
  allowPath(task, path);
  writeTask(home, task);
  const reporter = makeReporter("task allow", format, noColor);
  reporter.success(`${id} allow=[${task.allow.join(", ")}]`);
  reporter.finish({ id, allow: task.allow });
}

function cmdVerify(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "verify";
  const id = args[0];
  if (!id) fail(USAGE, 2);
  const reporter = makeReporter("verify", format, noColor);
  reporter.progress(`verifying ${id}...`);
  const res = verifyTask(cwd, id);
  const data = {
    id,
    verdict: res.verdict,
    phase: res.task.phase,
    treeSha: res.treeSha,
    message: res.message,
    iterations: res.task.iterations,
    stuck: res.stuck,
    limitReached: res.limitReached,
    ...(res.task.last_failure ? { failure: res.task.last_failure } : {}),
  };
  if (res.verdict === "pass") {
    reporter.success(`verdict=pass ${res.message}`);
    reporter.success(
      `${id} IN_REVIEW; record a review with: sddx review record ${id} --verdict pass|fail`,
    );
    reporter.finish(data);
    return;
  }
  reporter.error(`verdict=fail ${res.message}`);
  if (res.stuck) {
    reporter.error(
      `${id} is stuck: the same failure repeated; escalate to a person instead of iterating`,
    );
  }
  if (res.limitReached) {
    reporter.error(
      `${id} reached its iteration limit (${res.task.iterations}); escalate, or abandon it`,
    );
  }
  reporter.finish(data, { status: "error" });
  process.exit(1);
}

function cmdReviewRecord(
  cwd: string,
  args: string[],
  format: OutputFormat,
  noColor: boolean,
): void {
  currentCommand = "review record";
  const id = args[0];
  const verdict = flag(args, "--verdict");
  const findings = flag(args, "--findings");
  if (!id || (verdict !== "pass" && verdict !== "fail")) fail(USAGE, 2);
  if (verdict === "fail" && !findings) {
    fail("review record: a fail verdict needs --findings <file> naming what must change", 2);
  }
  const reporter = makeReporter("review record", format, noColor);
  const harness = flag(args, "--harness");
  const reviewer = flag(args, "--reviewer");
  const res = recordReview(id, {
    cwd,
    verdict,
    ...(findings ? { findings } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(harness ? { harness } : {}),
    model: flag(args, "--model") ?? null,
    sddxVersion: sddxVersion(),
  });
  if (res.kind === "changed") {
    failWith(
      [
        `review record: the work changed after verify, so this review would not cover what gets merged. ${id} is IN_PROGRESS again; run sddx verify ${id} first.`,
      ],
      1,
      { id, phase: res.task.phase },
    );
  }
  if (res.kind === "failed") {
    reporter.success(
      `${id} review failed; back to IN_PROGRESS (findings: ${res.entry.findings_path})`,
    );
    reporter.finish({ id, verdict: "fail", phase: res.task.phase, review: res.entry });
    return;
  }
  reporter.success(
    `${id} DONE: receipt ${relative(cwd, res.receiptPath)}, commit ${res.commitSha}`,
  );
  const integration = res.integration;
  if (integration.result === "merged") {
    reporter.success(`merged into ${integration.runBranch} (${integration.mergeCommit})`);
  } else if (integration.result === "conflict") {
    reporter.error(
      `integration conflict: ${id} could not be merged into ${integration.runBranch}; the run branch is unchanged. Conflicting paths: ${(integration.conflicts ?? []).join(", ") || "(unknown)"}`,
      { stream: "stdout" },
    );
  } else if (integration.reason === "error") {
    reporter.error(
      `integration failed: ${integration.error}. ${id} is DONE and committed on sddx/${id}; the run branch ${integration.runBranch} is unchanged. Merge it by hand with: git merge --no-ff sddx/${id}`,
      { stream: "stdout" },
    );
  }
  reporter.finish({
    id,
    verdict: "pass",
    phase: res.task.phase,
    review: res.entry,
    receiptPath: res.receiptPath,
    commitSha: res.commitSha,
    integration,
  });
}

function cmdTaskShow(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "task show";
  const id = args[0];
  if (!id) fail(USAGE, 2);
  const task = resolveTaskState(resolveMainRepoRoot(cwd), id);
  if (!task) fail(`no such task: ${id}`);
  const reporter = makeReporter("task show", format, noColor);
  // raw, so terminal output stays valid JSON for anyone piping it
  if (format === "terminal") printLine(JSON.stringify(task, null, 2));
  else reporter.success(`task ${id}`);
  reporter.finish(task);
}

function cmdGoalShow(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "goal show";
  const id = args[0];
  if (!id) fail(USAGE, 2);
  const goal = readGoal(cwd, id);
  const reporter = makeReporter("goal show", format, noColor);
  if (format === "terminal") printLine(JSON.stringify(goal, null, 2));
  else reporter.success(`goal ${id}`);
  reporter.finish(goal);
}

function cmdBoard(cwd: string, format: OutputFormat, noColor: boolean): void {
  const res = computeBoard(resolveMainRepoRoot(cwd));
  const reporter = makeReporter("board", format, noColor);
  reporter.success(`${res.path}${res.changed ? "" : " (unchanged)"}`);
  reporter.finish(res.data);
}

function cmdAudit(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "audit";
  const unknown = args.filter((a) => a !== "--signatures" && a !== "--ci");
  if (unknown.length > 0) fail(USAGE, 2);
  const withSignatures = args.includes("--signatures");
  const reporter = makeReporter("audit", format, noColor);
  reporter.progress(
    `auditing receipts${withSignatures ? " (with signature verification)" : ""}...`,
  );
  const res = auditReceipts(cwd, { signatures: withSignatures, ci: args.includes("--ci") });
  for (const n of res.notes) reporter.success(n);
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
}

function cmdDoctor(cwd: string, format: OutputFormat, noColor: boolean): void {
  currentCommand = "doctor";
  const reporter = makeReporter("doctor", format, noColor);
  let root: string | null = null;
  try {
    const r = resolveMainRepoRoot(cwd);
    root = existsSync(join(r, ".git")) ? r : null;
  } catch {
    root = null;
  }
  const report = runDoctor({ cwd, root, runningVersion: sddxVersion() });
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

function cmdMigrate(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  currentCommand = "migrate";
  const reporter = makeReporter("migrate", format, noColor);
  const apply = args.includes("--yes");
  const root = resolveMainRepoRoot(cwd);
  const state = detectV5State(root);
  const busy = inFlight(state);
  if (busy.length > 0) {
    failWith(
      [
        "migrate: sddx 5 work is still in flight, and migrating would strand it:",
        ...busy.map((b) => `  ${b}`),
        "Finish it with sddx 5 (npx @glapsfun/sddx@5 ...), or close it out with sddx 5's `task phase <id> ABANDONED`, then run migrate again.",
      ],
      1,
      { inFlight: busy },
    );
  }
  const actions = planMigration(state);
  if (nothingToDo(actions)) {
    for (const a of actions) reporter.warn(`${a.kind} ${a.path}: ${a.detail}`);
    reporter.success("migrate: nothing to do; this repository holds no sddx 5 state");
    reporter.finish({ applied: false, actions });
    return;
  }
  for (const a of actions) {
    const line = `${a.kind.padEnd(7)} ${a.path}: ${a.detail}`;
    if (a.kind === "keep" || a.kind === "manual") reporter.warn(line);
    else reporter.success(line);
  }
  if (!apply) {
    reporter.success("migrate: preview only, nothing was written. Apply with: sddx migrate --yes");
    reporter.finish({ applied: false, actions });
    return;
  }
  applyMigration(root, state);
  reporter.success(
    'migrate: done. Receipts, approval tokens and goal refs were not touched. Commit the result as one commit, so `git revert` can undo it: git add -A .sddx .claude && git commit -m "chore: migrate sddx 5 to 6"',
  );
  reporter.finish({ applied: true, actions });
}

function cmdSpecCheck(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("spec check", format, noColor);
  const file = args[0];
  if (!file) fail(USAGE, 2);
  let text: string;
  try {
    text = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    fail(`spec check: cannot read ${file}`);
  }
  const { spec, errors } = parseGoalSpec(text);
  if (!spec) {
    failWith(
      errors.map((e) => formatSpecError(file, e)),
      1,
      { path: file, errors: errors.map((e) => ({ message: e.message, path: file, line: e.line })) },
    );
  }
  reporter.success(`${file}: valid, status ${spec.status}, ${spec.tasks.length} task(s)`);
  for (const d of spec.design.openDecisions) reporter.warn(`open decision: ${d}`);
  reporter.finish({
    path: file,
    status: spec.status,
    title: spec.title,
    tasks: spec.tasks.map((t) => ({ id: t.id, title: t.title })),
    openDecisions: spec.design.openDecisions,
    errors: [],
  });
}

function cmdCleanup(cwd: string, args: string[], format: OutputFormat, noColor: boolean): void {
  const reporter = makeReporter("cleanup", format, noColor);
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const branch = `sddx/${id}`;
  const wtPath = join(worktreesDir(cwd), id);
  const task = resolveTaskState(cwd, id);
  if (existsSync(wtPath)) {
    if (task && !isTerminal(task.phase)) {
      fail(
        `refusing: task ${id} is ${task.phase} and its worktree holds its only state; finish it, or abandon it first (sddx task abandon ${id} --reason <text>)`,
      );
    }
    if (isDirty(wtPath)) {
      fail(`refusing: worktree ${join(".sddx-worktrees", id)} has uncommitted changes`);
    }
    removeWorktree(cwd, wtPath);
    reporter.success(`removed worktree ${join(".sddx-worktrees", id)}`);
  }
  // An abandoned task's branch is never merged. Delete it only when it holds no
  // commit beyond its base, so abandoned work that was committed stays reachable.
  if (task?.phase === "ABANDONED" && task.workspace && branchExists(cwd, branch)) {
    const ahead = spawnSync(
      "git",
      ["rev-list", "--count", `${task.workspace.base_sha}..${branch}`],
      {
        cwd,
        encoding: "utf8",
      },
    );
    if (ahead.status === 0 && ahead.stdout.trim() === "0" && currentBranch(cwd) !== branch) {
      forceDeleteBranch(cwd, branch);
      reporter.success(`deleted branch ${branch} (abandoned, no commits beyond its base)`);
      reporter.finish({ id, branch, removed: true, abandoned: true });
      return;
    }
    reporter.success(`kept branch ${branch}: the abandoned task committed work there`);
    reporter.finish({ id, branch, removed: false, abandoned: true });
    return;
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
    `profile: ${cfg.profile}`,
    `schema_version: ${cfg.schema_version ?? "(unset: defaults apply)"}`,
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
    reporter.success("config validate: no .sddx/config.json, built-in defaults apply");
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
    reporter.success("config validate: .sddx/config.json OK, no issues found");
    reporter.finish({ hasConfig: true, warnings });
    return;
  }
  for (const w of warnings) reporter.error(w);
  reporter.error(`config validate: ${warnings.length} issue(s)`);
  reporter.finish({ hasConfig: true, warnings }, { status: "error" });
  process.exit(1);
}

/** Commands that must keep working on an unmigrated sddx 5 repository: the
 * migration itself and the read-only diagnostics that explain what is wrong. */
const V5_SAFE = new Set(["migrate", "audit", "doctor", "config"]);

async function main(argv: string[]): Promise<void> {
  const cwd = process.cwd();
  // `hook` speaks the harness's protocol (event JSON in, decision JSON out,
  // always exit 0), not sddx's, so it is routed before anything else can
  // contaminate a decision the harness is waiting on.
  if (argv[0] === "hook") runHook(argv[1], argv[2]);
  const { format, noColor, rest: cleaned } = parseOutputFlag(argv);
  currentFormat = format;
  currentNoColor = noColor;
  const [cmd, ...rest] = cleaned;
  if (cmd === "--version" || cmd === "-v") {
    printLine(sddxVersion());
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    printLine(USAGE);
    return;
  }
  rejectRemovedFlags(rest);
  const sub = rest[0];
  const removed = REMOVED_COMMANDS.find((r) => r.match(cmd, sub));
  if (removed) {
    const name = ["task", "goal"].includes(cmd) ? `${cmd} ${sub}` : cmd;
    failWith([`\`sddx ${name}\` ${removed.text}`], 2);
  }
  try {
    if (!V5_SAFE.has(cmd)) refuseOnV5State(cwd);
    const args = rest.slice(1);
    if (cmd === "spec" && sub === "check") return cmdSpecCheck(cwd, args, format, noColor);
    if (cmd === "plan" && sub === "check") return cmdPlanCheck(cwd, args, format, noColor);
    if (cmd === "plan" && sub === "approve") return cmdPlanApprove(cwd, args, format, noColor);
    if (cmd === "plan" && sub === "start") return cmdPlanStart(cwd, args, format, noColor);
    if (cmd === "task" && sub === "start") return cmdTaskStart(cwd, args, format, noColor);
    if (cmd === "task" && sub === "ready") return cmdTaskReady(cwd, args, format, noColor);
    if (cmd === "task" && sub === "abandon") return cmdTaskAbandon(cwd, args, format, noColor);
    if (cmd === "task" && sub === "show") return cmdTaskShow(cwd, args, format, noColor);
    if (cmd === "task" && sub === "phase") return cmdTaskPhase(cwd, args, format, noColor);
    if (cmd === "task" && sub === "allow") return cmdTaskAllow(cwd, args, format, noColor);
    if (cmd === "verify") return cmdVerify(cwd, rest, format, noColor);
    if (cmd === "review" && sub === "record") return cmdReviewRecord(cwd, args, format, noColor);
    if (cmd === "goal" && sub === "show") return cmdGoalShow(cwd, args, format, noColor);
    if (cmd === "board") return cmdBoard(cwd, format, noColor);
    if (cmd === "audit") return cmdAudit(cwd, rest, format, noColor);
    if (cmd === "pr" && sub === "create") return cmdPrCreate(cwd, args, format, noColor);
    if (cmd === "run" && sub === "report") return cmdRunReport(cwd, args, format, noColor);
    if (cmd === "cleanup") return cmdCleanup(cwd, rest, format, noColor);
    if (cmd === "sweep") return cmdSweep(cwd, format, noColor);
    if (cmd === "next-actions") return cmdNextActions(cwd, rest, format, noColor);
    if (cmd === "config" && sub === "show") return cmdConfigShow(cwd, args, format, noColor);
    if (cmd === "config" && sub === "validate") return cmdConfigValidate(cwd, format, noColor);
    if (cmd === "doctor") return cmdDoctor(cwd, format, noColor);
    if (cmd === "migrate") return cmdMigrate(cwd, rest, format, noColor);
    fail(USAGE, 2);
  } catch (e) {
    fail((e as Error).message);
  }
}

// Top-level await would change the bundle's module semantics; an explicit
// catch keeps the failure path identical to the synchronous one.
main(process.argv.slice(2)).catch((e: unknown) => {
  fail((e as Error).message);
});
