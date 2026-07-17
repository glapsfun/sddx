---
name: run
description: Flagship sddx flow — decompose a goal into oracle-backed task specs and run them through TDD loops in parallel git worktrees, each ending in a verified, hash-chained receipt. Use for multi-task goals or any task that should run isolated from the current checkout.
---

# /sddx:run

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Trivial single task and the user wants it in-session? `--solo` → follow
/sddx:quick instead (same gates, no subagents, no worktree).

## Flow

1. **Decompose** — dispatch the `orchestrator` agent with the goal. It returns
   independent tasks with disjoint file scopes (or one task — that's fine;
   a single-task run is just the degenerate case).
2. **Plan** — one `planner` agent per task writes the spec YAML. Specs without
   an executable oracle do not proceed: no oracle, no goal.
3. **Create** — per task, from the repo root:
   `... task create --spec <file> --workspace auto`
   Auto picks a worktree forked from origin/HEAD; it downgrades to branch mode
   (one notice line) when submodules or nested worktrees make that unsafe.
   Record each printed task id and worktree path.
4. **Execute in parallel** — dispatch ALL `tdd-executor` agents in a single
   message (one Task call per task), each given its task id and worktree path.
   Executors never leave their worktree.
5. **Verify** — per finished task, dispatch a `verifier` agent with the task id
   and worktree path. Only `sddx verify` sets DONE and writes the receipt.
6. **Report** — one line per task: id · branch · phase · receipt path. Then run
   `... sweep` to clear disposable leftovers (it skips anything dirty or
   unverified, loudly).

## Rules

- Merging `sddx/<id>` branches back is the **user's** decision. Offer it;
  never do it unasked.
- A task that exhausts its spec's `stop_rules` (default max_iterations) stops
  and is reported as stuck — escalate to the human, don't loop forever.
- Never dispatch two tasks whose specs touch the same files; re-decompose
  instead.
- State lives in `.sddx/` inside each task's own workspace and merges without
  conflict — one file per task, no exceptions.
