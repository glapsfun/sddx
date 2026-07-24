# Use branch mode

`worktree` mode (the default under `auto`) gives every task its own
isolated checkout. `branch` mode is the sequential fallback — one
`sddx/<task-id>` branch at a time in the current checkout — for the two
cases worktrees can't safely handle. A full runnable walkthrough is
[examples/05-branch-mode](../../examples/05-branch-mode/).

## When it's used

- **Forced explicitly** — `--workspace branch` on `task create` or `graph
  create`.
- **Automatic fallback under `auto`** — when the repo has git submodules
  (worktrees crossing submodule boundaries are unsafe), or when `git
  worktree` itself is unavailable. Either prints a one-line notice
  (`submodules detected → branch mode` / `git worktree unavailable → branch
  mode`) and proceeds — this is expected behavior, not a refusal.
- **userConfig `workspace_mode: branch`** — force it repo-wide; see
  [config.md](../reference/config.md).

## What's different from worktree mode

Everything else about the loop is identical — the same PLAN→RED→GREEN→VERIFY
phases, the same spec, the same oracle. Only the isolation mechanism
changes: branch mode works sequentially on `sddx/<id>` in the main checkout
instead of a separate directory, so two branch-mode tasks in the same repo
do compound if worked on out of order — finish one before starting the next.

## Dependent materialization in branch mode

A dependent task materializes the same way in branch mode as in worktree
mode, just onto a branch instead of a worktree: a single-parent dependent's
branch points at its parent's `DONE` commit directly; a fan-in dependent's
branch points at a merge commit built the same way — fork from the first
parent, `git merge --no-ff` the rest — using a throwaway worktree internally
to perform the merge, then removing it. The branch pointer keeps the merge
commit; nothing is left behind. See
[model-dag-dependencies.md](model-dag-dependencies.md) for the general
mechanics.
