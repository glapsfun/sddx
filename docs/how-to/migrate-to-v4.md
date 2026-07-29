# Migrate to sddx 4.0

4.0 removes every execution path except one. If you used `/sddx:run` and
`graph create`, almost nothing changes. If you used `/sddx:quick`, `--solo`,
`task create`, `goal create`, or any `--workspace` value other than the
default, this guide maps what you ran to what you run now.

## The one-sentence version

**A single task is a one-node run.** There is no small-task mode, no
in-session mode, and no non-worktree mode. Every task belongs to a goal, forks
its own worktree from a run branch, proves itself with an oracle, and ends in a
hash-chained receipt — whether the plan has one node or ten.

## Why

Every removed path was a second way to execute work, each with its own
isolation, integration, cleanup, and audit behavior. Keeping them meant "done"
meant something slightly different depending on how you started, and a
repository could end up with tasks that no run branch described. One contract
is the point of the tool.

## Command mappings

| 3.x | 4.0 |
| --- | --- |
| `/sddx:quick <task>` | `/sddx:run <task>` — it plans a one-node graph |
| `/sddx:run --solo` | `/sddx:run` |
| `sddx task create --spec s.yaml` | write a one-node `graph.yaml`, then `sddx graph create --graph graph.yaml` |
| `sddx task create --spec s.yaml --workspace worktree` | same as above (worktree is the only strategy) |
| `sddx task create --spec s.yaml --workspace branch` | same as above — see [Repositories that only worked in branch mode](#repositories-that-only-worked-in-branch-mode) |
| `sddx task create --spec s.yaml --workspace none` | same as above |
| `sddx task create --spec s.yaml --no-branch` | same as above |
| `sddx task create --spec s.yaml --depends-on <id>` | express the edge as `depends_on` in the graph |
| `sddx goal create --goal "..." --tasks a,b` | `sddx graph create --graph graph.yaml` — it registers the goal atomically, before any task |
| `sddx graph create --graph g.yaml --workspace <mode>` | `sddx graph create --graph g.yaml` |
| `sddx graph approve --graph g.yaml --workspace <mode>` | `sddx graph approve --graph g.yaml` |

`sddx task create` and `sddx goal create` do not silently vanish — they exit
non-zero with a message naming the replacement.

Unchanged: `task phase`, `task allow`, `task show`, `task materialize`,
`red-check`, `verify`, `board`, `audit`, `cleanup`, `sweep`, `pr create`,
`run report`, `next-actions`, `config show`, `config validate`. These are
execution-engine, inspection, and maintenance operations, not an alternative
way to run work.

## From `task create` to a one-node graph

Given a spec you already have:

```yaml
# spec.yaml — unchanged
task: health check returns ok
success_criteria:
  - "bun test tests/health.test.ts exits 0"
scope:
  - "health.ts"
  - "tests/**"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
```

Add a graph naming the goal that owns the run branch:

```yaml
# graph.yaml
schema_version: "1.0"
interaction_mode: human
goal: health endpoint reports ok
tasks:
  - alias: health
    spec: spec.yaml
```

Then:

```sh
sddx graph create --graph graph.yaml --dry-run   # validates, writes nothing
sddx graph approve --graph graph.yaml
sddx graph create --graph graph.yaml
```

The task's TDD loop then runs **inside its worktree** at
`.sddx-worktrees/<id>/`, not in your checkout. See
[examples/01-single-task](../../examples/01-single-task/) for the full
walkthrough.

## Configuration

| Removed key | What to do |
| --- | --- |
| `workspace_mode` | Delete it. Worktree is the invariant, so there is nothing to select. |
| `prefer_solo` | Delete it. A trivial task is a one-node run. |

`sddx config validate` names both by name — as *removed*, not as an
unrecognized typo — so you can find them:

```sh
sddx config validate
```

Neither key changes how anything runs, so a config that still contains them
executes correctly. They are noise, not breakage.

## Existing work from 3.x

**Completed tasks are untouched.** Receipts recording legacy workspace modes
stay auditable and chain-verifiable, completed legacy tasks keep displaying on
`board`, and `audit` never asks you to migrate anything. Read-only
compatibility is permanent, not a deprecation window.

**Unfinished tasks in `branch` or `none` mode are refused**, with a message
naming both remedies:

- finish it with a compatible 3.x sddx, or
- abandon it and recreate the work as a canonical run.

The refusal never modifies the task's state, and it fires before an oracle
would run — so nothing executes and no receipt is written. There is no
automatic conversion: a branch-mode task has no run branch, no goal, and a base
that cannot describe it, so anything sddx invented would be a guess about work
you are in the middle of.

## Repositories that only worked in branch mode

Branch mode existed as an automatic fallback when worktrees looked unsafe.
Both triggers have narrowed, so most repositories that used to downgrade now
work with worktrees directly:

- **Running from inside a linked worktree** is no longer a failed precondition.
- **Submodules** disqualify a repository only when some task's `scope` actually
  reaches into one, rather than any `.gitmodules` disqualifying the whole repo.

If a task's scope genuinely crosses a submodule boundary, sddx refuses the run
with a stated precondition and starts nothing — a loud refusal rather than a
silent downgrade into weaker isolation. Declaring a narrower `scope` is usually
the fix. Supporting those layouts with worktrees is separate work; reinstating
a branch fallback is not planned.

## Checklist

1. Replace `/sddx:quick` and `--solo` with `/sddx:run`.
2. Replace `task create` / `goal create` with a graph and `graph create`.
3. Drop every `--workspace` and `--no-branch` flag.
4. Delete `workspace_mode` and `prefer_solo` from `.sddx/config.json`.
5. Finish or abandon any in-flight `branch`/`none` task before upgrading.
6. Run `sddx audit` — the chain should verify across both eras.
