# Config reference

`.sddx/config.json` is the repository's reviewed policy. You do not need to
create it: when it is absent every key takes its default, and the first
`sddx plan start` writes it with the defaults below so it can be committed and
reviewed. Edit it by hand; agents cannot (the approval gate denies tool writes
to it). Read the effective values with `sddx config show` and check the file
with `sddx config validate` (see [cli.md](cli.md#sddx-config-show)).

Keys resolve in this order, highest first: environment variable (only where the
table lists one), then `.sddx/config.json`, then the default.

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | | `"2.0"` | The schema the file was written against. A `1.x` value means sddx 5 wrote it: run `sddx migrate`. |
| `interaction_mode` | config only | `human` | `human`: a person approves each plan before it starts. `auto`: plans start unattended up to the run branch, refused at any autonomy bound. |
| `auto_max_tasks` | config only | `6` | In `auto`, a plan with more tasks than this is refused. |
| `profile` | config only | `default` | `default`: the boundary proof in `sddx verify` is the test-first guarantee. `strict`: also deny implementation writes until a failing test run is recorded, on harnesses with blocking hooks. See [hooks.md](hooks.md). |
| `test_globs` | `SDDX_TEST_GLOBS` | empty | Space-separated extra globs classified as test files, both for the boundary proof and the strict gate. |
| `exempt_globs` | `SDDX_EXEMPT_GLOBS` | empty | Space-separated extra globs that are neither tests nor implementation (never scope-checked, never gated). |
| `oracle_runs_default` | `SDDX_ORACLE_RUNS` | `1` | How many times the GREEN half runs the oracle when the spec does not say; every run must pass. |
| `stuck_threshold` | `SDDX_STUCK_THRESHOLD` | `3` | Identical consecutive verify failures before a task is reported stuck. |
| `max_iterations_default` | | `5` | Verify runs plus failed reviews per attempt before sddx asks for a person. |
| `red_bash_allow` | `SDDX_RED_BASH_ALLOW` | empty | Strict profile: extra commands the Bash gate allows before the first failing test (extends the built-in list). |
| `board_enabled` | `SDDX_BOARD_ENABLED` | `true` | Regenerate `.sddx/BOARD.md` at session start. |
| `pr_host` | | auto-detected | `gh` or `glab` for `sddx pr create`; unset detects from the `origin` remote. |
| `agent_model` | | empty | Comma-separated `role=model` pairs, read by orchestration skills when dispatching subagents. Advisory only. |
| `verbose` | | `false` | `sddx config show` also names the source of each value. |

## Config-only keys, on purpose

`interaction_mode`, `auto_max_tasks` and `profile` have no environment variable
and no command-line flag. A flag or an inline `VAR=value` is part of the command
line an agent composes, so honoring either would let the constrained agent
switch its own gate off. A committed file is something a person edits and a
reviewer reads. For unattended CI, commit `"interaction_mode": "auto"`.

They also fail closed:

- an unreadable file, a typo or an out-of-domain `interaction_mode` resolves to
  `human`, never to `auto`;
- an out-of-domain `profile` resolves to `strict`, never to `default`.

`sddx config validate` names such a value and exits 1, and `sddx doctor` warns
about it.

## Validation

`sddx config validate` exits 1 when the file has any issue: an unrecognized key,
a key removed in sddx 6 (`runtime_scope`, `package_manager`, `adapters`, all
replaced by the plugin), a value outside its key's domain, a malformed
`agent_model` segment, or a `schema_version` written by sddx 5. A missing file
is not an issue. Unparseable JSON fails too.

## Removed in sddx 6

| Key | Why |
| --- | --- |
| `runtime_scope`, `package_manager`, `adapters` | Harness integration is installed per user by the sddx plugin, not generated into the repository, so there is nothing to configure here. `sddx migrate` drops them. |

`execution_mode` (renamed to `interaction_mode` in sddx 4) is still read when
`interaction_mode` is absent.
