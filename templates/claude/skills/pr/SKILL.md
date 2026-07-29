---
name: pr
description: Push a goal's run branch and open a PR/MR from it. Use when asked to open a PR for /sddx:run goals.
---

# /sddx:pr

CLI: `{{SDDX}}` (run from the repo root).

Run: `... pr create --goal <goal-id> [--title "<title>"]`

This is the sending end of the loop `/sddx:run` deliberately stops short of:
a goal's run branch — already continuously merged into as tasks pass their
oracles (see `run-branch-integration`) — pushed and opened as one PR/MR,
never invoked automatically, only when the user asks.

## What it does

1. **No completeness gate**: unlike a goal PR built retroactively, this reads
   `.sddx/goals/<goal-id>.json`'s `run_branch` and pushes it exactly as it
   stands — whatever subset of tasks has merged into it so far. A goal with
   outstanding tasks is a perfectly valid thing to ship; the PR body states
   the outstanding count rather than implying full completion.
2. **Auth preflight**: resolves the host CLI (`gh` or `glab`, from
   `userConfig.pr_host` or detected from the `origin` remote) and checks it's
   authenticated *before* pushing — a failed preflight leaves nothing to
   clean up.
3. **Pushes the run branch as-is** — no reconstruction, no cherry-picking.
   Every commit on it is either a task's own atomic commit or a real
   `git merge --no-ff` that `sddx verify` already made; nothing new is built
   for this step.
4. **Opens the PR** with a body generated from the goal's `merges` log — only
   tasks currently merged (a reverted merge doesn't count), each with its
   oracle command, exit code, and receipt hash — never hand-written prose.
5. On success, writes `shipped: {pr_url, at}` onto the goal file. Re-running
   `pr create` for an already-shipped goal refuses rather than opening a
   duplicate.

## Report

Print the PR URL, the run branch name, and the task ids it currently
contains (from the goal's `merges` log, not the full task list). If the
command refuses, report the exact reason verbatim.

## Never

- Run this without being asked — same posture as merging into the target
  branch. Automatic merging into the *run branch* is `sddx verify`'s job, not
  this command's, and already happened by the time this runs.
- Retry a push failure by force-pushing or rewriting the run branch's
  history — fix the underlying problem (auth, remote, network) and re-run
  `pr create`.
- Merge the run branch into the target branch as part of this flow — that's
  a separate, explicit action via `next-actions --goal <goal-id>`.
