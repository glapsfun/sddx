# Design principles

The tie-breakers for any design argument, in order of how often they settle
one. When two things sddx could do conflict, the earlier principle wins.

1. **Process over intelligence.** Trust deterministic gates (the CLI, git,
   schemas, exit codes) over model judgment. A rule the CLI enforces can't be
   rationalized around; a rule stated in a prompt can. Skills say which gate
   comes next; the gates decide.
2. **No oracle, no goal.** A spec without an observable success signal is
   rejected at plan time, mechanically. See
   [spec-reference.md](../reference/spec-reference.md#oracle).
3. **State is files in git.** If it isn't committed, it didn't happen. Task
   state, specs, and receipts all live under version-controlled `.sddx/`, not
   in a chat session that dies with the context window.
4. **Hard rules, audited exceptions.** The only escape from the strict
   profile's per-edit gate is per-file, written down (`sddx task allow`), and
   surfaced in the receipt and on the board. See
   [../reference/hooks.md](../reference/hooks.md#the-allow-escape-hatch).
5. **Pay for what you use.** Orchestration scales with the plan, not with a
   mode switch: a trivial change is a **one-task goal**, which skips the
   decomposition and multi-task reporting a larger goal needs while getting the
   identical worktree, proof, review and receipt. There is no cheaper lifecycle
   to opt into, because a second lifecycle is what costs the most.
6. **Zero trust in "done".** Completion is a boundary proof, a review bound to
   the proven diff, and a chained receipt, never a model claim. See
   [verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md).
7. **Every guarantee holds without a harness.** The CLI and git enforce them
   all. Hooks add earlier feedback and the approval dialog, skills add steering,
   and neither is ever the only enforcement, so the guarantees hold in any
   harness, by hand, and in CI.

## Product goals

- **Density.** A goal becomes one markdown spec: a short design and tasks,
  each with an oracle. No ceremonial documents.
- **Proven test-first.** `sddx verify` proves each task's tests fail without the
  change and pass with it, in every harness. The strict profile adds hooks that
  block implementation writes before a failing test exists.
- **Parallel by default.** The execute skill dispatches one worker per ready
  task, each in its own worktree.
- **Provable completion.** Every finished task produces a
  machine-validated, hash-chained receipt bound to a commit SHA.
- **Repo-persistent.** All state lives in `.sddx/` under version control, in
  harness-neutral file formats.
- **Zero-footprint install.** One plugin install; no runtime dependencies;
  bundled single-file scripts; nothing generated into the repository; no
  network calls in the hooks or at session start. `sddx pr create` is the one
  stated exception: a command you invoke that shells out to `git push` and
  `gh` or `glab`, never part of the hot path.

## Why states are evidence, not claims

```
PLANNED ──► IN_PROGRESS ──► IN_REVIEW ──► DONE
                 │               │
                 └──── ABANDONED ┘
```

- **PLANNED**: the task exists in an approved, started plan, with an oracle and
  a scope.
- **IN_PROGRESS**: `sddx task start` created its worktree from the run branch.
- **IN_REVIEW**: `sddx verify` observed the oracle fail on the base with only
  the task's tests applied, and pass on the finished tree. Exit codes, not
  claims.
- **DONE**: `sddx review record` recorded a passing review of exactly the proven
  tree, committed it with its receipt, and merged it into the run branch.
- **ABANDONED**: given up, with a reason, or skipped because a dependency was.

This is principles 1 and 6 made concrete: nothing here is the model saying "I'm
done". Every transition is a CLI command reacting to evidence it checked
itself.
