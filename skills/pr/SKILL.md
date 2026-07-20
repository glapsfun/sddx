---
name: pr
description: Ship a done goal as one PR of cherry-picked commits. Use when asked to open a PR for /sddx:run goals.
---

# /sddx:pr

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Run: `... pr create --goal <goal-id> [--title "<title>"]`

This is the sending end of the loop `/sddx:run` deliberately stops short of:
one goal becomes one PR, built from that goal's already-verified task
commits — never invoked automatically, only when the user asks.

## What it does

1. **Gate**: refuses unless every task in `.sddx/goals/<goal-id>.json` is
   `DONE` with a passing receipt, re-read fresh at invocation time — no
   partial-goal PRs. On refusal it names exactly which task is blocking and
   why (wrong phase, no receipt, or missing entirely).
2. **Auth preflight**: resolves the host CLI (`gh` or `glab`, from
   `userConfig.pr_host` or detected from the `origin` remote) and checks it's
   authenticated *before* touching git — a failed preflight leaves nothing to
   clean up.
3. **Cherry-picks**, not merges: builds `sddx/goal-<goal-id>` from the
   resolved base and cherry-picks each task's single atomic commit onto it,
   in task-creation order. A conflict aborts the whole operation — no branch
   pushed, no partial PR — and names the task whose commit failed.
4. **Pushes** the goal branch, then opens the PR with a body generated from
   the receipts themselves (task id, oracle command, exit code, receipt
   hash) — never hand-written prose.
5. On success, writes a `shipped` marker onto every task's own branch and
   onto the goal file. This is what later lets `sddx cleanup <id>` delete a
   cherry-picked task branch even though it will never look "merged" by git
   ancestry.

## Report

Print the PR URL, the goal branch name, and the task ids it contains. If the
command refuses, report the exact reason verbatim — don't retry with a
different task set or paper over a blocking task by re-running `verify`
without a real fix.

## Never

- Run this without being asked — same posture as merging branches.
- Attempt a partial-goal PR by editing the goal file's `task_ids` to exclude
  a blocking task. If the user wants to ship early, that's a manual PR
  outside sddx, not this command.
- Retry a cherry-pick conflict by resolving it yourself inside the goal
  worktree — the command already cleans up and aborts; fix the underlying
  task (or report the conflict to the user) and re-run `pr create`.
