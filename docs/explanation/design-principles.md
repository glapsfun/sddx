# Design principles

The tie-breakers for any design argument, in order of how often they settle
one. When two things sddx could do conflict, the earlier principle wins.

1. **Process over intelligence.** Trust deterministic gates — hooks, schemas,
   exit codes — over model judgment. A rule enforced by a hook can't be
   rationalized around; a rule stated in a prompt can.
2. **No oracle, no goal.** A spec without an observable success signal is
   rejected at plan time, mechanically — see
   [spec-reference.md](../reference/spec-reference.md#oracle).
3. **State is files in git.** If it isn't committed, it didn't happen. Task
   state, specs, and receipts all live under version-controlled `.sddx/`, not
   in a chat session that dies with the context window.
4. **Hard rules, audited exceptions.** The only escape from the TDD gate is
   per-file, written down (`sddx task allow`), and surfaced in the receipt
   and on the board — see
   [../reference/hooks.md](../reference/hooks.md#the-allow-escape-hatch).
5. **Pay for what you use.** Subagents and worktrees only when the task
   warrants them; `--solo` runs a trivial task in the main session under the
   same hook gates, with no orchestration overhead.
6. **Zero trust in "done".** Completion is a verifier executing the oracle
   and writing a chained receipt — never a model claim. See
   [verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md).

## Product goals

- **Density.** A goal becomes a one-page spec with binary success criteria,
  an oracle, and stop rules — no ceremonial documents.
- **Deterministic TDD.** Red → Green → Refactor enforced by hooks, not by
  prompting. Hard-block, no soft mode.
- **Parallel by default.** `/sddx:run` decomposes work and dispatches tasks
  across isolated worktrees concurrently.
- **Provable completion.** Every finished task produces a
  machine-validated, hash-chained receipt bound to a commit SHA.
- **Repo-persistent.** All state lives in `.sddx/` under version control, in
  harness-neutral file formats.
- **Zero-footprint install.** No runtime dependencies; bundled single-file
  scripts; no network calls anywhere in the always-on core loop (install,
  hooks, session start). `sddx pr create` is the one stated exception — an
  explicitly user-invoked command that shells out to `git push`/`gh`/`glab`,
  opt-in and never part of the hot path.

## Why phases are evidence, not claims

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

- **PLAN** — the task exists with a spec and an oracle; writes to
  implementation paths are blocked.
- **RED** — a failing test has been *observed*, not asserted: the recorder
  saw the test runner exit non-zero (or, from the raw CLI,
  `task phase <id> RED --test-exit <n>` is refused unless `<n>` is actually
  non-zero).
- **GREEN** — the same observation, this time a zero exit. The gate opens.
- **REFACTOR** — optional cleanup; the tests must stay green.
- **VERIFY** — `sddx verify` executes the spec's oracle for real, writes a
  hash-chained receipt, and commits code + spec + receipt atomically.
- **DONE** — set only by the verifier, never claimed by hand.

This is principle 1 and principle 6 made concrete: nothing here is the model
saying "I'm done" — every transition is a hook or a CLI command reacting to
a real exit code.
