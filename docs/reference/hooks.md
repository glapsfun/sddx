# Hooks

sddx's guarantees live in the CLI and git: `plan start` refuses an unapproved
plan, `verify` runs the boundary proof, `review record` binds a review to the
proven diff, and every receipt is hash-chained. Those hold in any harness, or
with no harness at all.

Hooks add early feedback and the one thing a CLI cannot do on its own: raise
the user's own permission dialog. The harness plugin registers them (see
[Registration in Claude Code](#registration-in-claude-code) and
[Registration in Codex](#registration-in-codex)); the handlers are
`sddx hook <name>`, which read the harness event as JSON on stdin, write a
decision as JSON on stdout, and always exit 0, so a bug in sddx can never brick
a session.

## The handlers

| Handler | Event | Default profile | Strict profile |
| --- | --- | --- | --- |
| `session-start` | session start | injects context by repository state (see [What session start injects](#what-session-start-injects)) | same |
| `approval-gate` | before Bash and file-tool calls | asks on `plan approve` / `plan start`; denies writes to `.sddx/approvals/**`, `.sddx/config.json` and `.git/sddx-proofs/**` | same |
| `tdd-gate` | before file-tool writes | pass-through, never reads task state | denies implementation writes before a failing test is recorded; denies implementation writes outside the task's scope |
| `bash-gate` | before Bash | pass-through | before a failing test is recorded, only allow-listed test and read commands run |
| `record-test` | after Bash | ignored | records test-runner exit codes as the task's RED and GREEN evidence |
| `stop-gate` | session and subagent stop | blocks stopping while the governing task is `IN_PROGRESS` without a proof (allows it when stuck, at the iteration limit, or once `IN_REVIEW`) | same |

## Registration in Claude Code

The plugin's `hooks/hooks.json` registers every handler through one launcher,
`hooks/run-hook <handler>`:

| Event | Matcher | Handlers, in order | Timeout |
| --- | --- | --- | --- |
| `SessionStart` | `startup`, `clear`, `compact` | `session-start` | 10 s |
| `PreToolUse` | `Bash` | `approval-gate`, `bash-gate` | 30 s, 10 s |
| `PreToolUse` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `approval-gate`, `tdd-gate` | 30 s, 10 s |
| `PostToolUse` | `Bash` | `record-test` | 10 s |
| `Stop` | (every stop) | `stop-gate` | 10 s |
| `SubagentStop` | (every stop) | `stop-gate` | 10 s |

`resume` and `fork` are not matched: a resumed or forked session keeps the
context its start injected. The approval gate gets a longer timeout because a
timed-out hook is a non-blocking error in Claude Code, which for this gate would
mean no dialog.

### What the launcher decides before starting Bun

The launcher is a POSIX `sh` script. It finds Bun on `PATH`, or at
`~/.bun/bin/bun` when a session starts with a broken `PATH`, and decides in
shell whether the handler needs to run at all:

- `approval-gate` runs in every repository, because the first approval token or
  config write can come before `.sddx/` exists. It starts Bun only when the
  event's JSON, lowercased and with quote characters, backslashes and escaped
  control characters deleted, contains `sddx`, `cli.mjs` or `cli.ts`. That
  filter is sound: every decision the handler can make other than pass-through
  needs one of those strings after the shell's own processing. A gated command
  names an sddx invocation, and the handler's lexer joins quoted and escaped
  pieces first, so `s'ddx'`, `s\ddx` and `SDDX` all gate; deleting characters
  joins them in the filter too, and can create a match but never destroy one.
  Every protected path contains `sddx`, the unreadable-expansion case requires
  the word `sddx`, and a relative path that resolves into `.sddx/` comes with a
  working directory that contains it. `tests/hook-prefilter.test.ts` runs the
  gate's own test corpus, plus split spellings, through both the launcher and
  the handler to hold this. Without `tr` and `sed` to normalize with, the
  handler always runs.
- `tdd-gate`, `bash-gate` and `record-test` start Bun only where the strict
  profile can apply. Their handlers do nothing unless the profile is `strict`,
  and each reads it from a particular repository: the strict gate from the
  written file's, so a session started elsewhere cannot switch a strict
  repository's gate off; the Bash gate and the recorder from the working
  directory and the target of a leading `cd`. The launcher looks where its
  handler looks. It skips Bun when every one of those repositories' main
  checkouts has no `.sddx/config.json`, no `profile` in it, or `"profile":
  "default"`; any other value, including an invalid one, counts as strict, as it
  does for the handlers. When it cannot work out the directory, the handler
  runs.
- `stop-gate` starts Bun only in an opted-in repository: a `.sddx/` directory in
  the working directory or an ancestor up to the git working-tree root. Outside
  a git working tree only the working directory itself counts.
- `session-start` always runs, so that every session learns whether sddx applies.

### Without Bun, and when a handler fails

- `session-start` injects one notice that sddx needs Bun, with the install
  command.
- `approval-gate` asks for any event whose normalized JSON mentions `sddx`, with
  a reason naming Bun, and passes everything else. A missing runtime never silently opens the
  gate.
- Every other hook passes through.
- When the handler exits non-zero or prints nothing, the launcher emits a
  pass-through decision, or `ask` for the approval gate. The launcher itself
  always exits 0, so exit status 2, which Claude Code treats as a blocking
  decision, never reaches the harness.

## Registration in Codex

`.codex-plugin/plugin.json` points Codex at `hooks/hooks-codex.json`, which runs
the same launcher as `sh "${PLUGIN_ROOT}/hooks/run-hook" <handler> codex`:

| Event | Matcher | Handlers, in order | Timeout |
| --- | --- | --- | --- |
| `SessionStart` | `startup`, `clear`, `compact` | `session-start` | 10 s |
| `PreToolUse` | `Bash` | `approval-gate` | 30 s |
| `PreToolUse` | `apply_patch` | `approval-gate` | 30 s |
| `Stop` | (every stop) | `stop-gate` | 10 s |
| `SubagentStop` | (every stop) | `stop-gate` | 10 s |

Codex runs a plugin's hooks only after you trust them in `/hooks`, and again
after every update of the plugin. Codex fills in `${PLUGIN_ROOT}` before your
login shell sees the command, and `sh` runs the launcher whether or not it kept
its execute permission, so the hooks work under any login shell.

### How decisions map to Codex

A Codex hook cannot raise a permission dialog, and Codex runs the call when a
hook fails, times out, or prints a key it does not know. So in Codex:

- Where the approval gate would ask, it denies, and the reason gives the command
  for you to type with Codex's `!` prefix, with the plugin's `bin/sddx` by
  absolute path. Codex runs a `!` command as your own, outside hooks and the
  sandbox.
- Without Bun, or when the handler fails or prints nothing, the approval gate
  denies any event that mentions sddx.
- `sddx plan approve` itself refuses with exit 3 when `CODEX_TOOL_CALL_ID` is
  set, which Codex sets on every command its agent runs. This catches an agent
  that runs the command as it is, even before the hooks are trusted. It is not a
  barrier: an agent can clear the variable, or write a token with a patch, and
  only the trusted hooks stop that.
- A patch from the `apply_patch` tool is judged by the files it adds, updates,
  deletes or moves to. So is an `apply_patch` heredoc in a shell command when
  its first line is `apply_patch <<'EOF'`, after any plain `cd <dir> &&`, with a
  quoted delimiter and nothing after it. Any other heredoc is judged as shell,
  body included.
- The strict profile's hooks are not registered: Codex reports no exit code
  after a shell command, so the recorder cannot work. A strict repository
  opened in Codex gets a note at session start.

## What session start injects

A plugin installed for your user loads in every repository you open, so session
start decides how much to say from the repository's state:

| Repository state | Claude Code | Codex |
| --- | --- | --- |
| Not opted in (no `.sddx/`) | One line: sddx is installed, and `/sddx:brainstorm` plans a change with it. Nothing is read or written. | The same line, naming `$sddx:brainstorm`. |
| Set up by sddx 5: a config with `schema_version` 1.x, an sddx 5 task file, or sddx 5 files or hooks under `.claude/` | A pointer to `sddx migrate`, applied with `--yes` only once the user agrees; when `.claude/` still holds sddx 5 files or hooks, a note that both sets of hooks would fire. No router. | The same. |
| Opted in | The repository root, the command to run sddx, any orphan worktrees swept, one line per task that is not `DONE` or `ABANDONED`, then the `using-sddx` router and `references/claude-code.md`. The board is refreshed. | The same, with `references/codex.md`. On the strict profile, a note that its per-edit gates do not run in Codex and that test runs are recorded with `sddx task phase`. |
| Bun missing, any repository | One notice from the launcher, with the install command. | The same. |

The command to run sddx is plain `sddx`, unless another executable named `sddx`
is on `PATH`, such as a global npm install of sddx 5. Claude Code puts the
plugin's `bin/` after your own `PATH` entries in the agent's shell, so that
other one would win. Session start then gives the plugin's `bin/sddx` by
absolute path and names the other executable. Codex puts no plugin directory on
the agent's `PATH` at all, so in Codex the command is always the plugin's
`bin/sddx` by absolute path.

Session start always exits 0. An internal error becomes a one-line diagnostic in
the injected context rather than a failed hook.

## The profile

`"profile"` in `.sddx/config.json` selects `default` or `strict`. It is
config-only and fails closed: an invalid value means `strict`. `sddx task start`
records the profile on the task, and `sddx verify` refuses a task whose recorded
profile differs from the current one, so a task is never verified under a gate
it was not held to. The receipt records the profile.

The strict profile needs blocking pre-tool hooks, so it is available only on
harnesses that have them. On a harness without them the same repository simply
gets the default behavior plus the boundary proof, which is the guarantee in
every profile.

## The approval gate

This is the one permission gate. The prohibition gates deny a write or say
nothing; they never emit "allow", because auto-approving would bypass the
user's own permission flow. The approval gate does the opposite: it emits
`permissionDecision: "ask"`, which raises the user's dialog even when the
session auto-accepts permissions. A model can type `sddx plan approve`, so a
CLI-only check proves only that the plan started is the plan approved; the
dialog is the signal a model cannot produce for itself.

- `sddx plan approve <spec>` always asks, whatever the mode and whatever tokens
  exist: recording approval is the act a person must perform.
- `sddx plan start <spec>` asks when no valid token covers the plan's current
  hash, and passes when one does or when `auto` mode authorizes it. A hard
  refusal is left to the CLI, which exits 1.
- Only an sddx invocation's `plan` subcommand is gated (`terraform plan` is not).
  The command line is lexed quote-aware, compound lines are split, and wrappers
  (`sh -c`, `eval`, `xargs`, `env` and similar) are unwrapped. A line using an
  expansion the lexer cannot read, and naming both sddx and plan, asks.
- A write to `.sddx/approvals/**` (a forged approval), `.sddx/config.json` (a
  flipped mode or profile) or `.git/sddx-proofs/**` (a forged boundary proof,
  see [verification.md](verification.md)) is denied, by a file tool or by a
  shell command. The
  shell check is textual: it sees `..` and doubled slashes but not shell
  expansion, so it raises the bar behind the file-tool block rather than sealing
  it. Reading those files is allowed.
- It fails closed: any error resolves to `ask`.

## The strict TDD gate

For a write by a file tool, under the strict profile, for a task that is
`IN_PROGRESS` and was started under strict, the target is classified in order,
first match wins:

1. the task's allow list (`sddx task allow`);
2. exempt globs (built-ins plus `exempt_globs`);
3. test globs (built-ins plus `test_globs`);
4. otherwise implementation.

An implementation write is denied until a failing test run is recorded for the
task, and is denied whenever it falls outside the task's `scope`. Built-in globs
come from `src/lib/classify.ts`:

```
exempt:  .sddx/**   docs/**   **/*.md   package.json   tsconfig.json
         .github/**   openspec/**   .claude/**
tests:   **/*.test.*   **/*.spec.*   **/*_test.*   **/test_*.py
         tests/**   test/**   __tests__/**   spec/**
```

The same classification decides which changed files the boundary proof applies
in its RED half, in every profile.

## The strict Bash gate

Before a failing test is recorded, every segment of a Bash command (split on
pipes, `&&`, `;` and newlines) must start with an allow-listed command: test
runners and runtimes (`bun`, `npm`, `npx`, `pnpm`, `yarn`, `pytest`, `go`,
`cargo`, `make`, `node`, `python`, `python3`), read tools (`ls`, `cat`, `grep`,
`rg`, `find`, `head`, `tail`, `wc`), `git status|diff|log|show`, `cd`, which
writes nothing, and the sddx CLI itself.

A command that starts with `cd <dir> &&` or `cd <dir>;` runs the rest in that
directory, which is how a subagent works in its task's worktree: its shell
starts in the session's directory. The Bash gate judges the rest of the command
both where it started and where the `cd` moved to, so a `cd` out of a strict
worktree does not escape its gate, and the recorder counts a test run for the
task in the directory it ran in. Only a plain directory word is read; a quoted
or expanded one leaves the command judged where it started. Redirection with `>`, command or process substitution, and the runtimes'
eval flags are refused outright. `red_bash_allow` extends the list.

## The recorder and `task phase`

Under strict, the recorder watches Bash commands that start with a known test
runner (`bun test`, `npm test`, `pnpm test`, `yarn test`, `npx vitest`,
`npx jest`, `pytest`, `go test`, `cargo test`). The first failing run records
RED, which lifts both gates; a passing run after it records GREEN. Every run is
kept, and a strict receipt lists them. For a runner the recorder does not
recognize, record the run by hand; the exit code is checked, not trusted:

```sh
sddx task phase <id> RED --test-exit 1
sddx task phase <id> GREEN --test-exit 0
```

## The allow escape hatch

```sh
sddx task allow <id> <path>
```

Exempts one exact path for one task, under strict only, and never in `auto`
mode, where nobody is present to grant it. Every exemption appears on the board
and in the receipt's `allow` list. Use it for files that genuinely cannot be
test-driven, such as generated code.
