# Config reference

Every `userConfig` key sddx resolves, in precedence order (highest wins):
**environment variable** (where one exists) → **`.sddx/config.json`** →
**built-in default**. Inside Claude Code, enabling the plugin prompts for
these and materializes them into `.sddx/config.json` for you — there are no
hand-edited files in that path. Outside Claude Code (standalone CLI), write
`.sddx/config.json` yourself; see
[tune-config.md](../how-to/tune-config.md) for a worked example and
[cli.md](cli.md#sddx-config-show) for the `sddx config show`/`sddx config
validate` commands that read and check it.

| Key                       | Env var                 | Default            | Meaning                                                                                                  |
| -------------------------- | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------|
| `workspace_mode`           | —                        | `auto`              | Task workspace strategy: `auto` \| `worktree` \| `branch` \| `none`                                      |
| `test_globs`                | `SDDX_TEST_GLOBS`        | *(empty)*            | Space-separated extra globs classified as test files by the TDD gate                                     |
| `exempt_globs`              | `SDDX_EXEMPT_GLOBS`      | *(empty)*            | Space-separated extra globs exempt from the RED-phase write block                                        |
| `max_iterations_default`   | —                        | `5`                  | Default stop rule: max loop iterations per task                                                           |
| `board_enabled`             | `SDDX_BOARD_ENABLED`     | `true`               | Regenerate `.sddx/BOARD.md` automatically                                                                 |
| `oracle_runs_default`       | `SDDX_ORACLE_RUNS`       | `1`                  | How many times `sddx verify` executes the oracle; every run must pass (flakiness detection)               |
| `red_bash_allow`            | `SDDX_RED_BASH_ALLOW`    | *(empty)*            | Space-separated extra commands the RED-phase Bash gate allows (extends, never replaces, the built-in list)|
| `stuck_threshold`           | `SDDX_STUCK_THRESHOLD`   | `3`                  | Consecutive identical test failures before a task is flagged stuck                                        |
| `pr_host`                   | —                        | *(auto-detected)*     | PR-host CLI for `sddx pr create`: `gh` \| `glab`. Unset detects from the `origin` remote                  |
| `agent_model`               | —                        | *(empty)*             | Comma-separated `role=model` pairs (`orchestrator`, `planner`, `tddExecutor`, `verifier`) — advisory only |
| `prefer_solo`                | —                        | `false`               | Advisory hint `/sddx:run` reads to steer a single trivial task toward `--solo`/`/sddx:quick`             |
| `verbose`                    | —                        | `false`               | When true, `sddx config show` also prints which source resolved each key                                  |

A key with no env var column entry is resolved from `.sddx/config.json` or
the built-in default only — setting an environment variable of a similar
name has no effect on it.

## Validation

`sddx config validate` checks `.sddx/config.json` against the schema above
and reports, as **warnings** (exit 0, never a hard failure for a
structurally-valid file): unrecognized top-level keys, and values that fail
their key's domain rule — not just a `typeof` mismatch. `stuck_threshold`,
`oracle_runs_default`, and `max_iterations_default` must be positive
integers; `workspace_mode` must be one of `auto|worktree|branch|none`;
`pr_host` one of `gh|glab`; malformed `agent_model` segments (not
`role=model`, or an unrecognized role) are reported individually. A missing
`.sddx/config.json` is not an error — built-in defaults apply. The one case
that **does** fail loudly (exit 1) is unparseable JSON, or JSON that isn't an
object — that is a broken file, not a schema mismatch.

## `agent_model` parsing

`agent_model` is a single string of comma-separated `role=model` pairs, e.g.
`orchestrator=opus,tddExecutor=sonnet`. Recognized roles: `orchestrator`,
`planner`, `tddExecutor`, `verifier`. A malformed segment (no `=`, empty
model, or an unrecognized role) is dropped individually with a warning
rather than invalidating the whole value. This key is **advisory only**:
`/sddx:run` and `/sddx:quick` read it via `sddx config show --output json`
when dispatching a subagent, but no hook enforces it.
