# sddx examples

One runnable scaffold per major feature — `cd` into any of these, run its
`setup.sh`, and follow its `README.md`. Every command shown is copy-paste
real; the same commands are replayed by `tests/examples.e2e.test.ts` in CI,
so an example that stops working is a test failure, not stale prose.

| Example | Feature | Docs |
| --- | --- | --- |
| [01-single-task](01-single-task/) | The base loop, one task, no worktree | [Getting started](../docs/tutorials/01-getting-started.md) |
| [02-parallel-run](02-parallel-run/) | Independent tasks, parallel worktrees | [Your first parallel run](../docs/tutorials/02-your-first-parallel-run.md) |
| [03-dag-dependencies](03-dag-dependencies/) | Fan-out/fan-in, the overlap ⟹ ordered gate | [Model DAG dependencies](../docs/how-to/model-dag-dependencies.md) |
| [04-retry-and-skip](04-retry-and-skip/) | Bounded retry, skip vs block | [Configure retry and skip/block](../docs/how-to/configure-retry-and-skip.md) |
| [05-branch-mode](05-branch-mode/) | The submodule fallback, forcing branch mode | [Use branch mode](../docs/how-to/use-branch-mode.md) |
| [06-oracle-types](06-oracle-types/) | The four oracle types, and manual's real limit | [Choose an oracle type](../docs/how-to/choose-an-oracle-type.md) |
| [07-receipts-and-audit](07-receipts-and-audit/) | Inspecting, auditing, and tampering with a receipt | [Verify and audit receipts](../docs/how-to/verify-and-audit-receipts.md) |
| [08-pr-from-goal](08-pr-from-goal/) | `pr create`'s local refusal paths | [Ship a goal as a PR](../docs/how-to/ship-a-goal-as-a-pr.md) |
| [09-config-tuning](09-config-tuning/) | Precedence, `config validate`'s warnings | [Tune config](../docs/how-to/tune-config.md) |

Each `setup.sh` accepts an optional target-directory argument — defaults to
a gitignored `.sandbox/` next to the script for a convenient local run; the
test suite passes its own scratch directory instead.
