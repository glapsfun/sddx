# Getting started: your first verified task

This walks a **one-node run** by hand from the CLI, so you can see every phase
transition as it happens. A single task is not a special mode — it is a run
with one node, and it gets the same goal, run branch, worktree, oracle, and
receipt as a ten-node one. This is what `/sddx:run` drives for you inside
Claude Code. The exact commands are also a copy-paste-able scaffold at
[examples/01-single-task](../../examples/01-single-task/).

## The loop

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

Every arrow is a hook or a CLI command reacting to a real exit code, never a
model claim — see
[design-principles.md](../explanation/design-principles.md#why-phases-are-evidence-not-claims)
for why that's the whole point.

## 1. Write a spec and a one-node graph

A spec is one YAML file with a one-sentence goal, binary success criteria,
and a mandatory **oracle** — the command that proves the task is done:

```yaml
# spec.yaml
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

A graph names the **goal** that owns the run branch. Even one task needs one,
because a task with no goal is a task no run branch describes:

```yaml
# graph.yaml
schema_version: "1.0"
interaction_mode: human
goal: health endpoint reports ok
tasks:
  - alias: health
    spec: spec.yaml
```

`sddx graph create --graph graph.yaml --dry-run` validates everything and
writes nothing. Then `sddx graph approve --graph graph.yaml` followed by
`sddx graph create --graph graph.yaml` creates the run branch, the task's
`sddx/<id>` branch, its worktree, and the goal record — atomically, or not at
all. A spec without an oracle is rejected right here — "no oracle, no goal" —
see [spec-reference.md](../reference/spec-reference.md#oracle).

**The rest of the loop runs inside the task's worktree**, at
`.sddx-worktrees/<id>/`. Your own checkout stays untouched and writable.

## 2. Write the failing test first

The task starts in `PLAN`. Write a test against code that doesn't exist yet,
run it, and watch it fail — that failure **is** the RED-phase evidence:

```sh
bun test tests/health.test.ts   # fails: module not found
```

`sddx task phase <id> RED --test-exit 1` records that observed exit code;
passing `--test-exit 0` here is refused outright — the transition demands
real evidence, not a claim.

## 3. Prove the oracle itself discriminates

Before implementing, run `sddx red-check <id>` — it executes the spec's own
oracle command right now, while the implementation is still missing, and
records the failure as `evidence.oracle_red`. `sddx verify` later refuses any
task missing this: an oracle that never failed proves nothing.

## 4. Implement, go green

Write the implementation, re-run the test, and once it passes,
`sddx task phase <id> GREEN --test-exit 0` records that too. The optional
`REFACTOR` phase is free cleanup time — tests just have to stay green.

## 5. Verify

`sddx task phase <id> VERIFY` then `sddx verify <id>` executes the oracle for
real, writes a hash-chained receipt to `.sddx/receipts/<id>.json`, and makes
one atomic commit of the code, the spec, and the receipt. `sddx board` and
`sddx audit` confirm the result — the full receipt schema and what audit
checks are in
[receipts-schema.md](../reference/receipts-schema.md).

## Inside Claude Code

The same loop, without the by-hand phase commands: `/sddx:run` drives this
exact sequence — for one node or many — ending in the deterministic **Next
Actions** menu instead of free-form "what's next" prose. Next:
[your first parallel run](02-your-first-parallel-run.md), which is the same
lifecycle with more than one node in the graph.

Coming from sddx 3.x, where this was `/sddx:quick` or `--solo`? See
[migrate-to-v4.md](../how-to/migrate-to-v4.md).
