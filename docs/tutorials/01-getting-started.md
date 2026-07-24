# Getting started: your first verified task

This walks the same loop `/sddx:quick` (or `--solo`) drives inside Claude
Code, by hand from the CLI, so you can see every phase transition as it
happens. The exact commands are also a copy-paste-able scaffold at
[examples/01-single-task](../../examples/01-single-task/).

## The loop

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

Every arrow is a hook or a CLI command reacting to a real exit code, never a
model claim — see
[design-principles.md](../explanation/design-principles.md#why-phases-are-evidence-not-claims)
for why that's the whole point.

## 1. Register a task from a spec

A spec is one YAML file with a one-sentence goal, binary success criteria,
and a mandatory **oracle** — the command that proves the task is done:

```yaml
task: health check returns ok
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
```

`sddx task create --spec spec.yaml --workspace none` registers it and prints
`created <id> phase=PLAN ...` — `--workspace none` runs in place, no branch,
no worktree (see
[../tutorials/02-your-first-parallel-run.md](02-your-first-parallel-run.md)
for the worktree case). A spec without an oracle is rejected right here —
"no oracle, no goal" — see
[spec-reference.md](../reference/spec-reference.md#oracle).

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

The same loop, without the by-hand phase commands: `/sddx:quick` drives one
task through this exact sequence, ending in the deterministic **Next
Actions** menu instead of free-form "what's next" prose. `--solo` is the same
thing said explicitly for a trivial task — no subagents, no worktree, same
hook gates. Next:
[your first parallel run](02-your-first-parallel-run.md).
