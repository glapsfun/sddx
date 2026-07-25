// Deterministic post-task "Next Actions" menu: detect real git/PR state,
// filter a static action catalog to what's valid, resolve a numeric or
// natural-language reply, execute via existing git/PR primitives, report the
// observable result. State is derived fresh on every call — never persisted.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commit,
  commitsAheadOfUpstream,
  currentBranch,
  defaultBranch,
  git,
  headSha,
  push,
  stageAll,
  upstreamBranch,
} from "./git";
import { currentlyMergedTaskIds, readGoal } from "./goal";
import { createGoalPr } from "./pr";
import { resolveBackend } from "./prhost";
import { revertTaskMerge } from "./runbranch";
import { resolveTaskState } from "./task";
import { isDirty } from "./worktree";

export type RepoState = "uncommitted" | "committed-unpushed" | "pushed-no-pr" | "pr-open";

export interface DetectedState {
  state: RepoState;
  branch: string;
  /** Set when a PR/MR host lookup couldn't be completed (network/auth) — the
   * state still degrades to a safe local-only value, this just explains why
   * PR-dependent actions might be missing. */
  warning: string | null;
}

/** Resolves PR/MR existence for `branch`, degrading to local-only state (with
 * a warning) when the host can't be reached rather than guessing. */
function prLookup(cwd: string, branch: string): { state: RepoState; warning: string | null } {
  let backend: ReturnType<typeof resolveBackend>;
  try {
    backend = resolveBackend(cwd);
  } catch {
    return {
      state: "pushed-no-pr",
      warning: "cannot determine PR host — showing local-only actions",
    };
  }
  const auth = backend.authStatus(cwd);
  if (!auth.ok) {
    return {
      state: "pushed-no-pr",
      warning: `${backend.name} is not authenticated — showing local-only actions`,
    };
  }
  const found = backend.findPr(cwd, branch);
  return { state: found ? "pr-open" : "pushed-no-pr", warning: null };
}

export function detectState(cwd: string): DetectedState {
  const branch = currentBranch(cwd);
  if (isDirty(cwd)) return { state: "uncommitted", branch, warning: null };
  const upstream = upstreamBranch(cwd);
  if (!upstream || commitsAheadOfUpstream(cwd) > 0) {
    return { state: "committed-unpushed", branch, warning: null };
  }
  const { state, warning } = prLookup(cwd, branch);
  return { state, branch, warning };
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ActionContext {
  branch: string;
}

export type ActionCategory = "git" | "development" | "quality" | "other";

export interface Action {
  id: string;
  label: string;
  category: ActionCategory;
  validIn: RepoState[];
  aliases?: string[];
  /** false for documented-but-not-shipped future actions — never shown. */
  implemented: boolean;
  run?: (cwd: string, ctx: ActionContext) => ActionResult;
}

function runTestsAction(cwd: string): ActionResult {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, message: "no package.json found — nothing to run" };
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    hasTestScript = Boolean(pkg.scripts?.test);
  } catch {
    return { ok: false, message: "package.json is unreadable — cannot determine the test script" };
  }
  if (!hasTestScript) return { ok: false, message: 'no "test" script in package.json' };
  const r = spawnSync("npm", ["test", "--silent"], { cwd, encoding: "utf8" });
  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return { ok: r.status === 0, message: output || `exit ${r.status}` };
}

export const CATALOG: Action[] = [
  {
    id: "commit",
    label: "Commit",
    category: "git",
    validIn: ["uncommitted"],
    implemented: true,
    run(cwd) {
      stageAll(cwd);
      const sha = commit(cwd, "sddx: checkpoint");
      return { ok: true, message: `committed ${sha}` };
    },
  },
  {
    id: "commit-push",
    label: "Commit & Push",
    category: "git",
    validIn: ["uncommitted"],
    aliases: ["commit and push"],
    implemented: true,
    run(cwd, ctx) {
      stageAll(cwd);
      const sha = commit(cwd, "sddx: checkpoint");
      push(cwd, ctx.branch);
      return { ok: true, message: `committed ${sha} and pushed ${ctx.branch}` };
    },
  },
  {
    id: "push",
    label: "Push",
    category: "git",
    validIn: ["committed-unpushed"],
    implemented: true,
    run(cwd, ctx) {
      push(cwd, ctx.branch);
      return { ok: true, message: `pushed ${ctx.branch}` };
    },
  },
  {
    id: "create-pr",
    label: "Create PR/MR",
    category: "git",
    validIn: ["committed-unpushed", "pushed-no-pr"],
    aliases: ["create pull request", "create merge request", "open pr", "open mr"],
    implemented: true,
    run(cwd, ctx) {
      const backend = resolveBackend(cwd);
      const upstream = upstreamBranch(cwd);
      if (!upstream) push(cwd, ctx.branch);
      const url = backend.openPr(cwd, { branch: ctx.branch, title: ctx.branch, body: "" });
      return { ok: true, message: `opened ${url}` };
    },
  },
  {
    id: "merge-branch",
    label: "Merge Branch",
    category: "git",
    validIn: ["committed-unpushed"],
    implemented: true,
    run(cwd, ctx) {
      const target = defaultBranch(cwd);
      git(cwd, "checkout", target);
      try {
        git(cwd, "merge", "--no-ff", "-m", `sddx: merge ${ctx.branch}`, ctx.branch);
      } catch (e) {
        git(cwd, "checkout", ctx.branch);
        throw e;
      }
      return { ok: true, message: `merged ${ctx.branch} into ${target} (${headSha(cwd)})` };
    },
  },
  {
    id: "merge-to-main",
    label: "Merge to Main",
    category: "git",
    validIn: ["pr-open"],
    implemented: true,
    run(cwd, ctx) {
      const backend = resolveBackend(cwd);
      const report = backend.mergePr(cwd, ctx.branch);
      return { ok: true, message: report || `merged ${ctx.branch}` };
    },
  },
  {
    id: "continue-working",
    label: "Continue Working",
    category: "development",
    validIn: ["uncommitted", "committed-unpushed", "pushed-no-pr", "pr-open"],
    implemented: true,
    run() {
      return { ok: true, message: "continuing — no action taken" };
    },
  },
  {
    id: "start-next-task",
    label: "Start Next Task",
    category: "development",
    validIn: ["pr-open"],
    implemented: true,
    run() {
      return { ok: true, message: "run /sddx:plan or /sddx:run to start the next task" };
    },
  },
  {
    id: "show-diff",
    label: "Show Git Diff",
    category: "quality",
    validIn: ["uncommitted"],
    implemented: true,
    run(cwd) {
      const diff = git(cwd, "diff", "HEAD");
      return { ok: true, message: diff || "(no changes)" };
    },
  },
  {
    id: "run-tests",
    label: "Run Tests",
    category: "quality",
    validIn: ["uncommitted"],
    implemented: true,
    run(cwd) {
      return runTestsAction(cwd);
    },
  },
  {
    id: "discard-changes",
    label: "Discard Changes",
    category: "other",
    validIn: ["uncommitted"],
    implemented: true,
    run(cwd) {
      git(cwd, "checkout", "--", ".");
      git(cwd, "clean", "-fd");
      return { ok: true, message: "discarded uncommitted changes" };
    },
  },
  {
    id: "exit",
    label: "Exit",
    category: "other",
    validIn: ["uncommitted", "committed-unpushed", "pushed-no-pr", "pr-open"],
    implemented: true,
    run() {
      return { ok: true, message: "session ended" };
    },
  },
  // Documented future catalog — never shown (implemented: false).
  {
    id: "create-release",
    label: "Create Release",
    category: "other",
    validIn: [],
    implemented: false,
  },
  { id: "create-tag", label: "Create Git Tag", category: "other", validIn: [], implemented: false },
  { id: "deploy", label: "Deploy", category: "other", validIn: [], implemented: false },
  {
    id: "generate-changelog",
    label: "Generate Changelog",
    category: "other",
    validIn: [],
    implemented: false,
  },
  {
    id: "generate-release-notes",
    label: "Generate Release Notes",
    category: "other",
    validIn: [],
    implemented: false,
  },
  {
    id: "run-security-scan",
    label: "Run Security Scan",
    category: "other",
    validIn: [],
    implemented: false,
  },
  {
    id: "run-performance-tests",
    label: "Run Performance Tests",
    category: "other",
    validIn: [],
    implemented: false,
  },
  {
    id: "open-project-dashboard",
    label: "Open Project Dashboard",
    category: "other",
    validIn: [],
    implemented: false,
  },
  {
    id: "switch-branch",
    label: "Switch Branch",
    category: "other",
    validIn: [],
    implemented: false,
  },
];

const CATEGORY_ORDER: ActionCategory[] = ["git", "development", "quality", "other"];
const CATEGORY_LABEL: Record<ActionCategory, string> = {
  git: "Git",
  development: "Development",
  quality: "Quality",
  other: "Other",
};

/** The menu for `state`, in the fixed category order the numbering follows. */
export function visibleActions(state: RepoState): Action[] {
  return CATALOG.filter((a) => a.implemented && a.validIn.includes(state)).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

export function renderMenu(visible: Action[]): string {
  const lines = ["Next Actions", ""];
  let n = 0;
  for (const cat of CATEGORY_ORDER) {
    const inCat = visible.filter((a) => a.category === cat);
    if (inCat.length === 0) continue;
    lines.push(CATEGORY_LABEL[cat]);
    for (const a of inCat) {
      n++;
      lines.push(`${n}. ${a.label}`);
    }
    lines.push("");
  }
  lines.push("Reply with the action number or simply type the action name.");
  return lines.join("\n").trimEnd();
}

export type SelectionResult = Action | { error: "not-found" | "ambiguous" };

/** Lowercase, punctuation-stripped, whitespace-collapsed — applied to both the
 * user's input and every label/alias, so punctuation in a label (e.g. "Create
 * PR/MR") doesn't block matching it against itself. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Numeric index (1-based, into `visible` in its rendered order) first, then a
 * normalized match against label/aliases — restricted to `visible` only, so an
 * action valid in some other state can never be selected here. */
export function resolveSelection(input: string, visible: Action[]): SelectionResult {
  const trimmed = input.trim();
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= visible.length) {
    return visible[asIndex - 1] as Action;
  }
  const normalized = normalize(trimmed);
  const matches = visible.filter(
    (a) =>
      normalize(a.label) === normalized ||
      (a.aliases ?? []).some((alias) => normalize(alias) === normalized),
  );
  if (matches.length === 1) return matches[0] as Action;
  if (matches.length > 1) return { error: "ambiguous" };
  return { error: "not-found" };
}

// --- Run-scoped menu (end of `/sddx:run`, keyed to a goal's run branch) ---
//
// The per-task menu above answers "what can I do with the branch I'm
// currently on"; this answers "what can I do with the run this goal just
// produced" — review the combined diff, retry/revert individual tasks, ship
// or land the run branch. It reuses `renderMenu`/`resolveSelection` (both
// operate on any `Action[]`) rather than the static `CATALOG`/`RepoState`
// machinery above, since the action set here is built per-task (one "revert"
// per currently-merged task, one "retry" per failed one), not a fixed list
// filtered by a single state value.

export interface RunDetectedState {
  goalId: string;
  runBranch: string;
  baseSha: string;
  targetBranch: string;
  mergedTaskIds: string[];
  failedTaskIds: string[];
  outstandingTaskIds: string[];
  shipped: { pr_url: string; at: string } | null;
}

/** Reads the goal fresh (never a cached snapshot) and classifies every listed
 * task as merged, failed (ABANDONED), or still outstanding (in flight, or its
 * merge conflicted). */
export function detectRunState(cwd: string, goalId: string): RunDetectedState {
  const goal = readGoal(cwd, goalId);
  const merged = currentlyMergedTaskIds(goal);
  const failed = goal.task_ids.filter((id) => {
    if (merged.includes(id)) return false;
    return resolveTaskState(cwd, id)?.phase === "ABANDONED";
  });
  const outstanding = goal.task_ids.filter((id) => !merged.includes(id) && !failed.includes(id));
  return {
    goalId: goal.id,
    runBranch: goal.run_branch,
    baseSha: goal.base_sha,
    targetBranch: defaultBranch(cwd),
    mergedTaskIds: merged,
    failedTaskIds: failed,
    outstandingTaskIds: outstanding,
    shipped: goal.shipped ?? null,
  };
}

/** Builds the run-scoped action list for `state` — dynamic per-task revert
 * and retry entries, plus the fixed run-level actions, each already filtered
 * to what's currently valid (e.g. no "create PR" until something has merged). */
export function runActions(cwd: string, state: RunDetectedState): Action[] {
  const actions: Action[] = [
    {
      id: "review",
      label: "Review Changes",
      category: "quality",
      validIn: [],
      implemented: true,
      run(cwd, ctx) {
        const diff = git(cwd, "diff", `${state.baseSha}...${ctx.branch}`);
        return { ok: true, message: diff || "(no changes)" };
      },
    },
  ];

  for (const taskId of state.failedTaskIds) {
    actions.push({
      id: `retry-${taskId}`,
      label: `Retry ${taskId}`,
      category: "development",
      validIn: [],
      aliases: [`retry ${taskId}`],
      implemented: true,
      run() {
        return {
          ok: true,
          message:
            `${taskId} is ABANDONED (retry budget exhausted) — re-plan and dispatch a fresh ` +
            "attempt for it; the rest of the run is unaffected",
        };
      },
    });
  }

  for (const taskId of state.mergedTaskIds) {
    actions.push({
      id: `revert-${taskId}`,
      label: `Revert ${taskId}`,
      category: "git",
      validIn: [],
      aliases: [`revert ${taskId}`],
      implemented: true,
      run(cwd) {
        const sha = revertTaskMerge(cwd, state.goalId, taskId);
        return { ok: true, message: `reverted ${taskId}'s merge (${sha})` };
      },
    });
  }

  // Excludes `.sddx/goals` — same pathspec `stageAll` itself uses — so an
  // eternally-untracked goal file (never committed by design) doesn't make
  // this look dirty when there's genuinely nothing else to commit.
  if (git(cwd, "status", "--porcelain", "--", ".", ":!.sddx/goals") !== "") {
    actions.push({
      id: "commit-remaining",
      label: "Commit Remaining Changes",
      category: "git",
      validIn: [],
      implemented: true,
      run(cwd) {
        stageAll(cwd);
        if (git(cwd, "diff", "--cached", "--name-only") === "") {
          return { ok: false, message: "nothing to commit" };
        }
        const sha = commit(cwd, "sddx: checkpoint");
        return { ok: true, message: `committed ${sha}` };
      },
    });
  }

  actions.push({
    id: "push-run-branch",
    label: "Push Run Branch",
    category: "git",
    validIn: [],
    implemented: true,
    run(cwd, ctx) {
      push(cwd, ctx.branch);
      return { ok: true, message: `pushed ${ctx.branch}` };
    },
  });

  if (state.mergedTaskIds.length > 0 && !state.shipped) {
    actions.push({
      id: "create-pr",
      label: "Create PR/MR",
      category: "git",
      validIn: [],
      aliases: ["create pull request", "create merge request", "open pr", "open mr"],
      implemented: true,
      run(cwd) {
        const res = createGoalPr(cwd, state.goalId);
        return { ok: true, message: `opened ${res.prUrl}` };
      },
    });
  }

  if (state.mergedTaskIds.length > 0) {
    actions.push({
      id: "merge-to-target",
      label: "Merge Into Target Branch",
      category: "git",
      validIn: [],
      implemented: true,
      run(cwd, ctx) {
        git(cwd, "switch", state.targetBranch);
        git(cwd, "merge", "--no-ff", "-m", `sddx: merge ${ctx.branch}`, ctx.branch);
        return { ok: true, message: `merged ${ctx.branch} into ${state.targetBranch}` };
      },
    });
  }

  actions.push({
    id: "exit",
    label: "Exit",
    category: "other",
    validIn: [],
    implemented: true,
    run() {
      return { ok: true, message: "session ended" };
    },
  });

  return actions;
}
