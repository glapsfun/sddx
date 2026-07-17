# Hooks and the TDD gate

Hook enforcement is the identity of sddx: Red → Green → Refactor is a rule the
harness enforces, not a request the model can skip. This page documents what
each hook does, how the gate decides, and the one escape hatch.

All hooks run one dependency-free bundle (`dist/hooks.mjs`) through the
bun-or-node launcher, with a 10-second timeout.

## The hooks

| Event          | Matcher                              | Mode           | Job                                                                                       |
| -------------- | ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------- |
| `SessionStart` | —                                    | `session-start` | Bootstrap: orphan-worktree sweep, board refresh, active tasks surfaced as session context |
| `PreToolUse`   | `Edit\|Write\|MultiEdit\|NotebookEdit` | `tdd-gate`     | **TDD gate** — before GREEN (phases PLAN/RED), writes to implementation paths are denied  |
| `PreToolUse`   | `Bash`                               | `bash-gate`    | **Bash gate** — pre-GREEN, only allow-listed test/read commands run (see below)           |
| `PostToolUse`  | `Bash`                               | `record-test`  | Test-result recorder: observed test-runner exit codes drive PLAN→RED→GREEN                |
| `Stop`         | —                                    | `stop-gate`    | Refuses to conclude a session whose task lacks a verified receipt                         |
| `SubagentStop` | —                                    | `stop-gate`    | Same refusal for subagents                                                                |

## Gate classification

For every Edit/Write in phases PLAN or RED, the gate classifies the target
path in strict order — first match wins, and every decision names the rule
that made it:

1. **Task `allow` list** — exact paths granted via `sddx task allow` (see below).
2. **Exempt globs** — built-ins plus userConfig `exempt_globs`.
3. **Test globs** — built-ins plus userConfig `test_globs`.
4. **Otherwise: implementation** — blocked pre-GREEN. Hard-block, no soft mode.

The gate resolves its governing task from the written file's own workspace, so
it behaves identically in the main checkout, task worktrees, and subagents.

A blocked write gets an actionable message naming the task, the phase, and the
rule, then tells the model exactly what to do instead:

```
sddx TDD gate: blocked write to <path> — task <id> is in RED (rule: implementation path).
Before GREEN, only test files may change. Do this instead:
  1. Write a failing test for "<task sentence>" under a test path (**/*.test.*, **/*.spec.*, …).
  2. Run the test runner so the failure is recorded (the gate lifts in GREEN).
  3. Only for files that genuinely cannot be test-driven: sddx task allow <id> <path> — the exemption is audited in the receipt.
```

## Default globs

From `src/lib/classify.ts` — the source of truth.

Built-in **exempt** globs (state, docs, and config are never gated):

```
.sddx/**   docs/**   **/*.md   package.json   tsconfig.json
.github/**   openspec/**   .claude/**
```

Built-in **test** globs (per-language defaults):

```
**/*.test.*   **/*.spec.*   **/*_test.*   **/test_*.py
tests/**   test/**   __tests__/**   spec/**
```

Both lists extend via the plugin settings `exempt_globs` and `test_globs`
(space-separated; see [installation.md](installation.md)). Paths are
normalized to forward slashes before matching, so the gate classifies
identically on Windows.

## RED-phase Bash gate

`PreToolUse` on Bash: while the governing task is pre-GREEN (PLAN or RED),
a command runs only if the first word of **every** pipeline segment is on the
allow-list — test runners (`bun`, `npm`, `npx`, `pnpm`, `yarn`, `pytest`,
`go`, `cargo`, `make`), read tools (`ls`, `cat`, `grep`, `rg`, `find`,
`head`, `tail`, `wc`), and `git status|diff|log|show`. Any `>` redirection is
blocked outright — the gate does not parse targets. Extend (never replace)
the list with userConfig `red_bash_allow`. This closes the classic
`sed -i`/`tee` bypass around the Edit/Write gate.

## The allow escape hatch

The only way past the gate is per-file and audited:

```sh
sddx task allow <id> <path>
```

This appends the exact path to the task file's allow list. It is visible on
the board, and at verification the whole list is copied into the receipt
(`allow` field, receipt v2) — so every exemption a task ever used is part of
its tamper-evident record. See
[receipts-and-audit.md](receipts-and-audit.md).

There is no global off-switch and no soft mode. Use `allow` for files that
genuinely cannot be test-driven (generated code, vendored assets), not to
skip the loop.

## Phase transitions are evidence

Phases move on observed exit codes, never on claims:

- The **recorder** (`PostToolUse` on Bash) parses test-runner exit codes from
  commands matching the test globs: a non-zero exit in PLAN moves the task to
  RED; a zero exit in RED moves it to GREEN. The evidence (`--test-exit <n>`)
  is recorded in the task file.
- The **stop gate** refuses to conclude a session or subagent while its task
  lacks a verified receipt — "done" requires the verifier to have executed the
  oracle and written the chained receipt
  ([receipts-and-audit.md](receipts-and-audit.md)).
- A broken or unreadable task state file **blocks writes** rather than
  silently disabling the gate.
