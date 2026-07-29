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
| `test_globs`                | `SDDX_TEST_GLOBS`        | *(empty)*            | Space-separated extra globs classified as test files by the TDD gate                                     |
| `exempt_globs`              | `SDDX_EXEMPT_GLOBS`      | *(empty)*            | Space-separated extra globs exempt from the RED-phase write block                                        |
| `max_iterations_default`   | —                        | `5`                  | Default stop rule: max loop iterations per task                                                           |
| `board_enabled`             | `SDDX_BOARD_ENABLED`     | `true`               | Regenerate `.sddx/BOARD.md` automatically                                                                 |
| `oracle_runs_default`       | `SDDX_ORACLE_RUNS`       | `1`                  | How many times `sddx verify` executes the oracle; every run must pass (flakiness detection)               |
| `red_bash_allow`            | `SDDX_RED_BASH_ALLOW`    | *(empty)*            | Space-separated extra commands the RED-phase Bash gate allows (extends, never replaces, the built-in list)|
| `stuck_threshold`           | `SDDX_STUCK_THRESHOLD`   | `3`                  | Consecutive identical test failures before a task is flagged stuck                                        |
| `pr_host`                   | —                        | *(auto-detected)*     | PR-host CLI for `sddx pr create`: `gh` \| `glab`. Unset detects from the `origin` remote                  |
| `agent_model`               | —                        | *(empty)*             | Comma-separated `role=model` pairs (`intake`, `orchestrator`, `planner`, `tddExecutor`, `verifier`) — advisory only |
| `verbose`                    | —                        | `false`               | When true, `sddx config show` also prints which source resolved each key                                  |
| `interaction_mode`           | — (config only)          | `human`               | Whether a human is consulted before anything is created: `human` (one question round, then plan approval) or `auto` (unattended up to the run branch) |
| `auto_max_tasks`             | — (config only)          | `6`                   | In `auto`, a plan with more nodes than this is **refused**, not run unattended                             |

A key with no env var column entry is resolved from `.sddx/config.json` or
the built-in default only — setting an environment variable of a similar
name has no effect on it.

## Validation

`sddx config validate` checks `.sddx/config.json` against the schema above
and reports, as **warnings** (exit 0, never a hard failure for a
structurally-valid file): unrecognized top-level keys, and values that fail
their key's domain rule — not just a `typeof` mismatch. `stuck_threshold`,
`oracle_runs_default`, and `max_iterations_default` must be positive
integers; `interaction_mode` must be one of `human|auto`;
`pr_host` one of `gh|glab`; malformed `agent_model` segments (not
`role=model`, or an unrecognized role) are reported individually. A missing
`.sddx/config.json` is not an error — built-in defaults apply. The one case
that **does** fail loudly (exit 1) is unparseable JSON, or JSON that isn't an
object — that is a broken file, not a schema mismatch.

## `agent_model` parsing

`agent_model` is a single string of comma-separated `role=model` pairs, e.g.
`orchestrator=opus,tddExecutor=sonnet`. Recognized roles: `intake`,
`orchestrator`, `planner`, `tddExecutor`, `verifier`. A malformed segment (no `=`, empty
model, or an unrecognized role) is dropped individually with a warning
rather than invalidating the whole value. This key is **advisory only**:
`/sddx:run` reads it via `sddx config show --output json`
when dispatching a subagent, but no hook enforces it.

## The two gate keys are config-only, on purpose

`interaction_mode` and `auto_max_tasks` are the **only** keys with no environment
override, and they deliberately break the precedence ladder every other key
follows.

The reason is the threat model. A CLI flag and an inline `VAR=value` prefix are
both part of the command line an agent composes, so honoring either would let the
thing the approval gate constrains switch the gate off — `sddx graph create …
--mode auto` or `SDDX_INTERACTION_MODE=auto sddx …` would silently satisfy a user
who configured `human`. Raising `auto_max_tasks` from the environment would
likewise buy unattended blast radius. `.sddx/config.json` is a file a human
edits and a reviewer can read, and it is the only source a gate decision trusts.

For unattended CI, commit `interaction_mode: "auto"` — reviewable, unlike an env
var. There is no `--mode` flag on any command.

`interaction_mode` never falls through to `auto`: an unreadable config, a typo, or
an out-of-domain value all resolve to `human`. See
[interaction-modes.md](../explanation/interaction-modes.md).

## Migrating `execution_mode` → `interaction_mode`

The key was renamed. **Nothing breaks**: `execution_mode` is still read, and a
checkout configured before the rename keeps its mode. `sddx config validate`
reports it as a warning naming the replacement, and newly written config, goal
records, receipts, and output use the new name only.

```diff
 {
-  "execution_mode": "auto"
+  "interaction_mode": "auto"
 }
```

If both keys are present, `interaction_mode` wins and validation says so —
remove the old one. It wins even when its value is invalid: a mistyped
`interaction_mode` resolves to `human`, never through to a stale
`execution_mode: "auto"` left behind by a half-finished rename.

The name is the point of the change. `execution_mode` implied two ways of
executing; there is only one execution engine, and the two modes differ solely
in whether a human is consulted before materialization.

## `graph.yaml` gained a required header (breaking)

A graph draft that declares `tasks:` must now also carry a Goal Brief header —
at minimum `schema_version` and `interaction_mode`. A draft written before this
change fails parsing, naming the missing key:

```diff
+schema_version: "1.0"
+interaction_mode: human
 goal: ship the widget
 tasks:
   - alias: alpha
     spec: alpha.yaml
```

Two consequences worth knowing:

- **In-flight drafts only.** Nothing already materialized moves — task state,
  goal records, receipts, and the hash chain are untouched, because the header
  is read at plan time and denormalized into specs at create time. A goal that
  already reached `graph create` never re-parses its draft.
- **Approval tokens re-arm.** Adding the two lines changes the graph bytes and
  therefore the plan hash, so a token approved before the change no longer
  matches. Re-approve the plan. This is the same invalidation a spec edit
  already causes — the fingerprint working, not a regression.

The requirement is deliberately strict rather than defaulting silently. A header
key that defaults is a gate with a soft mode, and `interaction_mode` in
particular decides whether a plan needs a human at all — the one field whose
absence must never resolve to a guess.
