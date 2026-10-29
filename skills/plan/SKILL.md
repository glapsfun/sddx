---
name: plan
description: Use when a spec's Design is ready and it has no Tasks yet, or its tasks need revising. Splits the design into tasks with executable oracles and disjoint scopes, then takes the plan through check, approval and start.
---

# Plan

Append `## Tasks` to a ready spec and take it through the three plan gates.

## Write the tasks

Each task is `### <id> <title>` followed by one fenced `sddx` block.

<!-- spec-example -->
````markdown
# Rate limiting

## Design

### Goal
Limit each API client to 100 requests per minute.

### Acceptance
- the 101st request from one client inside a minute gets status 429
- a client's count resets once its minute ends

### Non-goals
- limits shared across several server instances

### Assumptions
- in-memory counters are enough: the API runs as a single instance

### Open decisions

## Tasks

### rl-1 Token bucket

```sddx
oracle:
  type: command
  run: bun test tests/bucket.test.ts
  expect: exit 0
scope: [src/rl/**, tests/bucket.test.ts]
```

### rl-2 Middleware returns 429

```sddx
oracle:
  type: test-suite
  run: bun test tests/middleware.test.ts
  expect: exit 0
scope: [src/middleware/**, tests/middleware.test.ts]
depends_on: rl-1
```
````

- **Oracle:** a command that fails today and passes once the task is done,
  usually the task's own test file. `sddx verify` runs it on the base with only
  the task's tests applied, where it must fail, and on the finished tree, where
  it must pass. Together the oracles must prove every Acceptance line.
- **Scope:** the globs the task may write, its tests included. Tasks that can
  run at the same time must have disjoint scopes.
- **Ids:** prefix them with a short goal slug (`rl-1`). They name branches,
  worktrees and receipts, so they must be unique in the repository.
- **Dependencies:** `depends_on` orders tasks. Keep tasks small enough that one
  worker finishes one in a session.

## Gates

1. Commit the spec. The plan gates read it from history, so they refuse a
   spec with uncommitted changes.
2. `sddx plan check <spec>` validates the plan and shows its hash, base and
   task count. Fix every error it lists, and commit again.
3. Show the user the plan and its hash, then run
   `sddx plan approve <spec> --harness <name>`. The user's permission dialog
   opens; their answer is the approval. If they decline, revise the plan with
   them. If no dialog can be shown, stop and ask them to run
   `sddx plan approve <spec>` themselves. Never write an approval token.
   In `auto` mode `plan approve` is not needed; `plan start` checks the auto
   bounds itself.
4. `sddx plan start <spec>` creates the goal, its run branch and the `PLANNED`
   tasks, and prints the goal id.

Then use the execute skill.
