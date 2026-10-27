# Verification: the boundary proof

`sddx verify <id>` decides whether a task's change is proven. It needs nothing
from the harness, no hook and no recorded session history: only git, the task's
oracle, and the files in the task's worktree. That is why it is the test-first
guarantee in every profile and in every harness, CI included.

## What it proves

Two things, in one throwaway proof worktree:

1. **RED:** the oracle fails on the base commit with only the task's changed
   test files applied. The tests catch the missing behavior; an oracle that
   passes here proves nothing about this task.
2. **GREEN:** the oracle passes on the exact tree being verified, `runs` times.

```
 task worktree (never modified)           proof worktree .sddx-worktrees/<id>--proof
 +----------------------------+           +---------------------------------------------+
 | base + the task's changes  |  tree T   | 1. detached checkout of the base commit     |
 | (tracked and new files,    | --------> | 2. apply only the changed TEST files from T |
 |  minus ignored files,      |           | 3. setup (if declared)                      |
 |  minus .sddx/)             |           | 4. oracle  -> must NOT exit as expected     |
 +----------------------------+           | 5. check out exactly T                      |
                                          | 6. setup (if declared)                      |
                                          | 7. oracle x runs -> must exit as expected   |
                                          | 8. remove the proof worktree (always)       |
                                          +---------------------------------------------+
```

Before either half, verify checks three things and fails without running the
oracle if one does not hold:

- The task file's `oracle` and `scope` equal the task's block in the approved
  spec, read from the run branch and checked against the plan hash the goal's
  approval recorded. The task file lives in the worktree an agent edits; the
  approved plan decides what verify runs and allows.
- Nothing under `.sddx/` differs from the base. sddx alone writes there, and
  only at finalize.
- No implementation file changed outside the task's `scope` globs (and not on
  its strict allow list). A type change, such as a file replaced by a symlink,
  counts. Test and exempt files may change anywhere.

On a pass the task moves to `IN_REVIEW`, and verify writes its proof record to
`.git/sddx-proofs/<id>.json`: the base commit, the verified tree, the changed
test files, the RED exit code and the GREEN runs, bound to the task's attempt.
The task file gets a copy for display, but `sddx review record` trusts only the
record in the git directory, and the approval gate denies tool writes to it.
The record becomes the receipt's `boundary` and `runs` once a review passes. On
a failure the task stays `IN_PROGRESS` and records which part failed (`scope`,
`setup`, `red` or `green`) and its exit code.

An agent with an unrestricted shell can still write any local file, this record
included. What the receipt proves is that the oracle, the base and the tree it
names are the ones verify ran: anyone can replay the proof from git.

## The verified tree

Verify snapshots the worktree's full content as a git tree using a temporary
index: tracked changes, new untracked files, no ignored files, and no
uncommitted `.sddx/` state. Neither the worktree's files nor its git index
change. `sddx review record` takes the same snapshot again and refuses the
review if it differs, so a review always covers exactly what was proven.

## setup

A fresh worktree has no ignored files, so no `node_modules/`, virtualenv or
build output. Declare how to create them:

<!-- spec-example: valid -->
````markdown
# Health endpoint

## Design

### Goal
A health function reports ok.

### Acceptance
- health() returns {status: "ok"}

### Non-goals

### Assumptions

### Open decisions

## Tasks

### h-1 Health function

```sddx
oracle:
  type: command
  run: bun test tests/health.test.ts
  expect: exit 0
  setup: bun install --frozen-lockfile
scope: [src/health.ts]
```
````

`setup` runs before each half. Ignored files it creates survive into the GREEN
half, so the second run is usually a cache hit. A failing setup fails verify.

Running both halves in the same proof worktree is deliberate. If the RED half
ran in a fresh checkout but the GREEN half in the task's own worktree, a missing
dependency would make the RED half fail for the wrong reason and still count. In
one environment, a broken setup fails the GREEN half too, so it can only make
verify fail, never pass.

## Which files are tests

The same classification as everywhere else in sddx (`src/lib/classify.ts`),
first match wins: exempt globs (built-ins plus `exempt_globs`), then test globs
(built-ins plus `test_globs`), otherwise implementation. Built-in test globs:

```
**/*.test.*   **/*.spec.*   **/*_test.*   **/test_*.py
tests/**   test/**   __tests__/**   spec/**
```

Additions, modifications, type changes and deletions of test files are all
applied in the RED half. Paths are read from NUL-delimited git output and
passed back to git as literal paths, so any file name works as written.

## The proof worktree

Verify creates `.sddx-worktrees/<id>--proof` locked with the reason
`sddx verify pid <pid> on <host>` and removes it when the proof ends, whatever
the outcome. `sddx sweep`, which runs at every session start, removes a proof
worktree only once the process named in its lock is gone, so one session cannot
pull the directory out from under another session's running oracle. A
leftover directory git no longer tracks is removed by the next verify of the
task and by sweep. A second verify of the same task while the first still runs
is refused.

## Known limitations

- **RED for the wrong reason.** A new test that imports a module the task
  creates fails at the base because the import fails, not because of an
  assertion. That still counts as RED. The RED output's hash is recorded so it
  can be checked later.
- **Tests inside implementation files.** Languages that keep tests next to the
  code in the same file (Rust's `#[cfg(test)]` modules, for example) cannot be
  separated by globs, so the RED half runs the base code without the new test.
  A filtered test runner usually passes with zero tests there, and verify fails
  with "the oracle passes without the change". This fails safe: restructure the
  test into its own file, or point the oracle at a separate check.
- **Manual oracles** need a person to observe the result, so verify refuses them.

## Stop rules

Each verify run and each failed review counts as an iteration. The same failure
(the same part, exit code and last lines of output, ignoring numbers such as
timings) repeated `stuck_threshold` times in a row marks the task stuck, and reaching
`max_iterations_default` asks for a person (see [config.md](config.md)). Neither
abandons the task on its own; `sddx task abandon` does.
