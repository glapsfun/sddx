# Your first parallel run

`/sddx:run` — the flagship flow — decomposes a goal into independent tasks
with disjoint file scopes, gives each its own git worktree forked from
`origin/HEAD`, and runs them through the same RED→GREEN→VERIFY loop from
[getting-started.md](01-getting-started.md) concurrently. This tutorial walks
the CLI primitive underneath it: `sddx graph create`. The full commands are a
runnable scaffold at
[examples/02-parallel-run](../../examples/02-parallel-run/).

## Why worktrees, not branches

Two tasks on one branch in one checkout compound: task B's uncommitted state
sits on top of task A's, and a mistake in A silently leaks into B. A
worktree per task forks its own checkout from a shared base commit — each
task's edits, tests, and git history stay physically separate until a human
(or `/sddx:pr`) decides to bring them back together. See
[design-principles.md](../explanation/design-principles.md) principle 3,
"state is files in git" — worktrees are that principle applied to isolation,
not just persistence.

## The graph is the unit of parallel work

A `graph.yaml` lists task nodes — an alias and a path to that task's spec —
with optional `depends_on` edges between them:

```yaml
goal: add two independent modules
tasks:
  - alias: alpha
    spec: specs/alpha.yaml
  - alias: bravo
    spec: specs/bravo.yaml
```

No edges here, so both are roots: `sddx graph create --graph graph.yaml`
validates every spec, checks that any two *unordered* tasks have disjoint
`scope` (the "overlap ⟹ ordered" gate —
[model-dag-dependencies.md](../how-to/model-dag-dependencies.md) covers the case where
they aren't independent), then creates both worktrees and registers a
**goal** tying the task ids together. Everything is validated before
anything is written — a bad spec in task three of ten refuses the whole
graph rather than leaving two worktrees to clean up by hand.

## Drive each worktree independently

Each worktree is a full, isolated checkout at `.sddx-worktrees/<id>` on
branch `sddx/<id>`. Change into one and it's the same single-task loop from
the previous tutorial — write the failing test, `task phase RED`,
`red-check`, implement, `task phase GREEN`, `verify`. In Claude Code,
`/sddx:run` hands each worktree to its own tdd-executor subagent and they run
genuinely concurrently; from the CLI, "parallel" means "independent," not
literally simultaneous in one terminal — you can drive them in any order, or
interleave commands across both, and neither affects the other's state.

## Check progress with the board

`sddx board` regenerates `.sddx/BOARD.md` — a deterministic table of every
task's phase, workspace, and receipt status across the main checkout *and*
every worktree. Re-run it any time; never hand-edit the file.

## Next

Two independent tasks are the simple case. When one task's work genuinely
depends on another's, that's
[model-dag-dependencies.md](../how-to/model-dag-dependencies.md).
