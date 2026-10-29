# Choose an oracle type

Every task's `sddx` block needs an `oracle`: the command whose exit code proves
the task is done. Four `oracle.type` values exist, but three run the same way
and the fourth cannot be verified by a machine. A runnable proof of both facts
is [examples/06-oracle-types](../../examples/06-oracle-types/).

## Pick a command that fails today

`sddx verify` runs the oracle twice. On the task's base commit with only the
task's changed test files applied it must **fail**, and on the finished tree it
must **pass**. So the best oracle runs the task's own tests: they fail before
the implementation exists and pass once it does. An oracle that already passes
on the base, such as a suite that does not include the new test, is refused.
See [Verification](../reference/verification.md).

## `command`, `test-suite`, `browser` run identically

All three run `oracle.run` through `sh -c` and compare the exit code with
`oracle.expect`. The type tells a reader what kind of proof `run` is; it does
not change how sddx runs it:

```sddx
oracle:
  type: command
  run: bun test tests/health.test.ts
  expect: exit 0
```

```sddx
oracle:
  type: test-suite
  run: bun test tests/api/
  expect: exit 0
```

```sddx
oracle:
  type: browser
  run: bunx playwright test e2e/login.spec.ts
  expect: exit 0
```

Prefer `command` or `test-suite` for anything a shell command can decide. Use
`browser` only when the behavior needs a rendered page; to sddx it is still a
shell command.

## `manual` cannot be verified

```sddx
oracle:
  type: manual
```

A manual oracle needs a person to observe the result, so `sddx verify` refuses
it, and `auto` mode refuses any plan that contains one. To prove an outcome no
command can check directly, model a proxy a command can observe, such as a
file a person creates after reviewing, and keep `type: command`.

## `runs` and `setup`

- `runs: <n>` runs the GREEN half `n` times, and every run must pass: a check
  for flaky tests. It defaults to the `oracle_runs_default` config key, else 1.
- `setup: <command>` runs in the proof worktree before each half, for example
  `bun install --frozen-lockfile`. A fresh worktree has no ignored dependency
  directories, so most projects need it.

Field by field: [Spec reference](../reference/spec-reference.md#oracle).
