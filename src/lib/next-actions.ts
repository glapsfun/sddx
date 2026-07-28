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

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ActionContext {
  branch: string;
}

export type ActionCategory = "git" | "development" | "quality" | "other";

/** One offerable action. `validIn` survives from the retired state-filtered
 * catalog and is unused by the run menu, which builds exactly the actions that
 * are valid rather than filtering a fixed list. */
export interface Action {
  id: string;
  label: string;
  category: ActionCategory;
  validIn: string[];
  aliases?: string[];
  /** false for documented-but-not-shipped future actions — never shown. */
  implemented: boolean;
  run?: (cwd: string, ctx: ActionContext) => ActionResult;
}

const CATEGORY_ORDER: ActionCategory[] = ["git", "development", "quality", "other"];
const CATEGORY_LABEL: Record<ActionCategory, string> = {
  git: "Git",
  development: "Development",
  quality: "Quality",
  other: "Other",
};

/**
 * The retired current-branch action catalog lived here.
 *
 * It answered a question about the CHECKOUT — is this branch dirty, pushed,
 * does it have a PR — and offered per-task handoffs keyed to that. Under the
 * canonical run lifecycle the only handoff is goal-scoped and comes once, after
 * the run summary, so a menu derived from ambient repository state could offer
 * actions before the run reached its single handoff point, and offer them for a
 * branch that had nothing to do with the run.
 *
 * `renderMenu` and `resolveSelection` survive because they operate on any
 * `Action[]`; only the state detector and the static catalog it filtered are
 * gone. See `runActions` below for the replacement.
 */

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
