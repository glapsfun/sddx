# Spec reference

A goal is described by one markdown file, `.sddx/specs/<YYYY-MM-DD>-<slug>.md`.
People read all of it. sddx interprets only two things: the skeleton of the
`## Design` section, and the fenced `sddx` block under each task in
`## Tasks`. Everything else is prose and is never parsed, so you can write
whatever explanation helps a reviewer without changing what is checked.

Check a spec at any time; it writes nothing:

```sh skip
sddx spec check .sddx/specs/2026-10-26-rate-limit.md
```

It exits 0 for a valid spec and reports its status (`draft` or `ready`), or
exits 1 listing every error with its line number. `--output json` returns the
same errors as `{message, path, line}` objects under `data.errors`.

## A complete example

<!-- spec-example: valid -->
````markdown
# Rate limiting

## Design

### Goal
Limit each API client to 100 requests per minute.

### Acceptance
- the 101st request inside a minute returns 429
- the limit resets after the minute ends

### Non-goals
- limits shared across several server instances

### Assumptions
- in-memory counters are enough for one instance

### Open decisions

### Approaches considered
Token bucket over fixed windows: it smooths bursts at the window edge.

## Tasks

### rl-1 Token bucket

```sddx
oracle:
  type: command
  run: bun test tests/bucket.test.ts
  expect: exit 0
scope: [src/rl/**, tests/bucket.test.ts]
```

### rl-2 Middleware

```sddx
oracle:
  type: test-suite
  run: bun test tests/middleware.test.ts
  expect: exit 0
  runs: 3
scope: [src/middleware/**, tests/middleware.test.ts]
depends_on: rl-1
```
````

## The file

- It must start with a level-1 heading naming the goal.
- It must contain `## Design`. It may contain `## Tasks`, which must come
  after `## Design`. Other level-2 sections are allowed and ignored.
- The goal id is the file name without `.md`, for example
  `2026-10-26-rate-limit`. It names the run branch
  (`sddx/run-<goal-id>`) and the goal record (`refs/sddx/goals/<goal-id>`).

## Design

`## Design` must contain these level-3 subsections, in any order:

| Subsection | Rule |
| --- | --- |
| `### Goal` | Non-empty text. |
| `### Acceptance` | At least one list item. Each item should be observable, because every task's oracle exists to prove some of them. |
| `### Non-goals` | List items, may be empty. |
| `### Assumptions` | List items, may be empty: what was decided without asking, and why. |
| `### Open decisions` | List items, may be empty. |

Any other subsection (approaches considered, architecture, trade-offs) is
prose and is ignored.

### Draft and ready

A spec whose `### Open decisions` list has items has status `draft`. It is
still a valid spec, but `sddx plan check`, `plan approve` and `plan start`
refuse it: a plan cannot rest on a decision nobody has made. Resolve each
open decision, move the outcome into the design, and empty the list to reach
status `ready`.

## Tasks

Each task is a level-3 heading `### <task-id> <title>` followed by exactly one
fenced code block whose info string is `sddx`. The block is YAML. Prose,
other code blocks and level-4 headings under the task are allowed and ignored.

### Task ids

A task id matches `[A-Za-z][A-Za-z0-9-]*` and must be unique in the file.
Task ids also name branches (`sddx/<task-id>`), worktrees
(`.sddx-worktrees/<task-id>`) and receipts (`.sddx/receipts/<task-id>.json`),
so `sddx plan check` refuses an id that any existing task or receipt in the
repository already uses. Prefix ids with a short goal slug (`rl-1`, `rl-2`)
to keep them unique across goals.

### Block keys

The key set is closed: an unknown key, including a misspelling, is an error.

| Key | Required | Meaning |
| --- | --- | --- |
| `oracle` | yes | The observable proof the task is done. No oracle, no goal. |
| `scope` | no | Non-empty list of write globs this task may touch. Tasks that can run at the same time must have disjoint scopes. |
| `depends_on` | no | A task id, or a list of task ids, that must be `DONE` before this task can start. |
| `on_dependency_failure` | no | `skip` (default): if a dependency is abandoned, this task is skipped and the rest of the goal continues. `block`: the goal halts. |
| `retry` | no | `{max_attempts: <n>, workspace: fresh \| reuse}`. Defaults to one attempt. |
| `assumptions` | no | Non-empty list of decisions specific to this task. |

### oracle

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `command`, `test-suite`, `browser` or `manual`. |
| `run` | yes, except `manual` | The command `sddx verify` runs. |
| `expect` | yes, except `manual` | `exit <code>`, for example `exit 0`. |
| `runs` | no | How many times the GREEN half runs; every run must match. Defaults to the `oracle_runs_default` config key, else 1. |
| `setup` | no | A command run in the proof worktree before each half of the boundary proof, for example `bun install --frozen-lockfile`. |

`sddx verify` proves the oracle twice: it must **fail** on the task's base
commit with only the task's changed test files applied, and **pass** on the
verified tree. See [verification.md](verification.md).

A `manual` oracle needs a person to observe the result. `sddx verify` refuses
it, and `auto` mode refuses any plan that contains one.

## Errors

`sddx spec check` reports every error in one run, each as `path:line: message`.
These are invalid:

<!-- spec-example: invalid -->
````markdown
# Missing acceptance

## Design

### Goal
Something.

### Non-goals

### Assumptions

### Open decisions
````

<!-- spec-example: invalid -->
````markdown
# Task without an oracle

## Design

### Goal
Something.

### Acceptance
- it works

### Non-goals

### Assumptions

### Open decisions

## Tasks

### T1 Do it

```sddx
scpoe: [src/**]
```
````
