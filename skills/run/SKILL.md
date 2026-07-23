---
name: run
description: Flagship sddx flow — decompose a goal into oracle-backed task specs and run them through TDD loops in parallel git worktrees, each ending in a verified, hash-chained receipt. Use for multi-task goals or any task that should run isolated from the current checkout.
---

# /sddx:run

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Trivial single task and the user wants it in-session? `--solo` → follow
/sddx:quick instead (same gates, no subagents, no worktree). If the goal looks
like a single trivial task, run `... config show --output json` first and
check `.data.prefer_solo` — when true, lean toward suggesting
`--solo`/`/sddx:quick` unless the user already asked for `/sddx:run`
explicitly. This is advisory only: no hook enforces it, it's a steer for this
skill's own judgment.

## Flow

0. **Read config** — run `... config show --output json` once and keep
   `.data.agent_model` (a `role=model` map, e.g. `{"tddExecutor": "opus"}`) for
   step 1 onward: when dispatching a subagent for a role present in that map,
   pass its model as the dispatch's model override; roles absent from the map
   use the harness default. (`--json` still works as a deprecated alias for
   `--output json`, but reads the same `.data.*` shape — not the bare fields
   an older sddx once printed at the top level.)
1. **Decompose into a graph** — dispatch the `orchestrator` agent with the goal.
   It authors `.sddx/drafts/<date>-<goal-slug>-graph.yaml`: one node per task
   with an `alias`, a `spec` path (a bare filename alongside the graph file —
   `graph create` resolves it relative to `graph.yaml`'s own directory), and
   at most one `depends_on` (an alias). Concurrent tasks (not ordered by an
   edge) must have **disjoint `scope`**; overlapping scope must be ordered
   with `depends_on`. One task is fine — a single-task run is the degenerate
   case.
2. **Plan** — one `planner` per node writes its spec YAML alongside the graph
   file under `.sddx/drafts/`, including a `scope` and an executable oracle:
   no oracle, no goal.
3. **Create atomically** — from the repo root:
   `... graph create --graph .sddx/drafts/<date>-<goal-slug>-graph.yaml`
   This is the gate: it validates every oracle, the single-parent forest, and
   **overlap ⟹ ordered**, then writes all task files (worktrees forked from
   origin/HEAD for roots; dependents deferred) and `.sddx/goals/<goal-id>.json`
   with its edges — or writes **nothing** and names the offending node. Auto
   downgrades to branch mode (one notice) when worktrees are unsafe. Record the
   printed alias→id map and goal id.
4. **Execute as a chain-walk** — dispatch a `tdd-executor` for every **ready**
   task (a root, or one whose parent is DONE) in a single message, each given
   its task id and worktree path. Executors never leave their worktree and run
   `... red-check <id>` once RED is recorded, before implementing.
5. **Verify and advance** — per finished task, dispatch a `verifier` (only
   `sddx verify` sets DONE and writes the receipt). Each dispatched verifier
   follows /sddx:verify, which on a pass runs `... next-actions` inside that
   task's own worktree/branch and relays it — so each task gets the same
   deterministic hand-off /sddx:quick uses, scoped to its own branch. When a
   parent reaches DONE, materialize each newly-ready child with
   `... task materialize <child-id>` (forks its worktree from the parent's
   DONE commit) and dispatch it. Repeat until the forest drains. A stuck task
   leaves its descendants **blocked** — report them, never dispatch them.
6. **Report** — run `... board --output markdown` and relay it: task rows
   (id · branch · phase, including `blocked-on-<id>`) and receipt references
   come from the same board data that `.sddx/BOARD.md` is built from, so the
   report and the committed board can never disagree. Prefer `--output json`
   instead when relaying to another tool/agent rather than a human. Then run
   `... sweep` to clear disposable leftovers (it skips anything dirty or
   unverified, loudly). `next-actions` is single-branch and doesn't know about
   goals, so it isn't run here: if every task is DONE, mention that
   `sddx pr create --goal <goal-id>` will open one PR for the whole goal — but
   offer it, never run it unasked.

## Rules

- Merging `sddx/<id>` branches back, and opening a PR for the goal, are the
  **user's** decision. Offer either; never do it unasked.
- A task that exhausts its spec's `stop_rules` (default max_iterations) stops
  and is reported as stuck — escalate to the human, don't loop forever.
- Never dispatch two tasks whose specs touch the same files; re-decompose
  instead. This isn't just a parallel-safety rule — it's also what keeps a
  later `pr create`'s cherry-picks conflict-free.
- State lives in `.sddx/` inside each task's own workspace and merges without
  conflict — one file per task, no exceptions. The goal file is the one
  exception that lives in the main checkout, since it spans multiple tasks'
  workspaces by definition.
