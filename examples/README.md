# sddx examples

One runnable scaffold per major feature. Run an example's `setup.sh`, `cd` into
the directory it prints, and follow its `README.md`. Every command shown is
real: `tests/examples.e2e.test.ts` replays each README in CI, and a block fails
the example if any command in it fails, so an example that stops working is a
test failure, not stale prose.

| Example | Feature | Docs |
| --- | --- | --- |
| [01-single-task](01-single-task/) | The whole loop for one task: spec, plan, task, verify, review, receipt | [Spec reference](../docs/reference/spec-reference.md) |
| [02-parallel-run](02-parallel-run/) | Independent tasks in parallel worktrees, one run branch | [CLI reference](../docs/reference/cli.md) |
| [03-dag-dependencies](03-dag-dependencies/) | Fan-out and fan-in; overlapping scopes must be ordered | [Model DAG dependencies](../docs/how-to/model-dag-dependencies.md) |
| [04-retry-and-skip](04-retry-and-skip/) | Retry policies, skip versus block | [Configure retry and skip/block](../docs/how-to/configure-retry-and-skip.md) |
| [06-oracle-types](06-oracle-types/) | The four oracle types, and why `manual` needs a person | [Verification](../docs/reference/verification.md) |
| [07-receipts-and-audit](07-receipts-and-audit/) | Reading a receipt, auditing the chain, catching tampering | [Receipts schema](../docs/reference/receipts-schema.md) |
| [08-pr-from-goal](08-pr-from-goal/) | A partly finished goal and `pr create`'s local refusal | [Ship a goal as a PR](../docs/how-to/ship-a-goal-as-a-pr.md) |
| [09-config-tuning](09-config-tuning/) | Precedence, config-only gate keys, `config validate` | [Config reference](../docs/reference/config.md) |

Each `setup.sh` accepts an optional target directory. It defaults to a
gitignored `.sandbox/` next to the script for a local run; the test suite passes
its own scratch directory.
