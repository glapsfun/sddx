# Hooks

sddx's guarantees live in the CLI and git: `plan start` refuses an unapproved
plan, `verify` runs the boundary proof, `review record` binds a review to the
proven diff, and every receipt is hash-chained. Those hold in any harness, or
with no harness at all.

Hooks add early feedback and the one thing a CLI cannot do on its own: raise
the user's own permission dialog. Each harness plugin registers them; the
handlers are `sddx hook <name>`, which read the harness event as JSON on stdin,
write a decision as JSON on stdout, and always exit 0, so a bug in sddx can
never brick a session.

## The handlers

| Handler | Event | Default profile | Strict profile |
| --- | --- | --- | --- |
| `session-start` | session start | sweeps orphan worktrees, refreshes the board, lists unfinished tasks | same |
| `approval-gate` | before Bash and file-tool calls | asks on `plan approve` / `plan start`; denies writes to `.sddx/approvals/**`, `.sddx/config.json` and `.git/sddx-proofs/**` | same |
| `tdd-gate` | before file-tool writes | pass-through, never reads task state | denies implementation writes before a failing test is recorded; denies implementation writes outside the task's scope |
| `bash-gate` | before Bash | pass-through | before a failing test is recorded, only allow-listed test and read commands run |
| `record-test` | after Bash | ignored | records test-runner exit codes as the task's RED and GREEN evidence |
| `stop-gate` | session and subagent stop | blocks stopping while the governing task is `IN_PROGRESS` without a proof (allows it when stuck, at the iteration limit, or once `IN_REVIEW`) | same |

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
`rg`, `find`, `head`, `tail`, `wc`), `git status|diff|log|show`, and the sddx CLI
itself. Redirection with `>`, command or process substitution, and the runtimes'
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
