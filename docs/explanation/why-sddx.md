# Why sddx

**One sentence:** a fast, dense alternative to Superpowers: process over
intelligence, proof over promises.

sddx is a lightweight Spec-Driven Development (SDD) framework, shipped as a
Claude Code plugin. It turns vague development goals into dense,
machine-verifiable specs through conversation, runs each task in its own git
worktree, proves every change with a boundary RED/GREEN proof and a review of
the proven diff, and leaves behind a tamper-evident audit trail of receipts
inside the repository. The harness writes the code; sddx is the gate and the
manager.

## The problem

Agentic dev frameworks suffer from five recurring failure modes:

- **Token bloat.** Large always-on skill libraries tax every session before
  any work starts.
- **Prompt-level discipline.** "Write the test first" is a request, not a
  rule, and the model can and does skip it.
- **Unverifiable completion.** "Done" is a model claim, not an observable
  fact.
- **Transient state.** Progress lives in the chat session and dies with it.
- **Sequential compounding.** Consecutive tasks on one branch contaminate
  each other.

## The answer

| Problem                 | sddx mechanism                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------|
| Token bloat              | Minimal skill surface; lazy-loaded references; measured token budget                        |
| Prompt-level discipline  | `sddx verify` **proves** the tests fail without the change and pass with it; the strict profile adds hooks that block implementation writes before a failing test exists |
| Unverifiable completion  | Every task requires an **oracle**, an observable success signal the CLI executes, and a review bound to the proven diff |
| Transient state          | Per-task JSON state + receipts committed **in the repo**; survives restarts and compaction  |
| Compounding tasks        | **Worktree-per-task** isolation, forked from the goal's run branch, parallel by default      |

The mechanisms themselves are covered task-by-task starting from
[docs/tutorials/01-getting-started.md](../tutorials/01-getting-started.md);
the reasoning behind each one is in
[design-principles.md](design-principles.md).

## Non-goals

- A live web UI board: sddx generates `BOARD.md` only.
- Harnesses beyond Claude Code and Codex for now. Every guarantee lives in the
  CLI, the skills are written harness-neutrally, and every receipt records the
  harness it reports.
- Large-scale project management (epics, sprints). sddx targets small-to-medium
  tasks and batches of them.

## Success metrics

- Fresh install to first reviewed task in **under 10 minutes**.
- Always-on skill and agent descriptions under **600 tokens**, and the router a
  session loads under **1,500**, enforced on every test run by
  `scripts/token-budget.ts`.
- A task whose tests pass without its change **never** passes `sddx verify`.
- Two or more parallel tasks complete with **zero** merge conflicts in
  `.sddx/` and a valid receipt chain.
- `sddx audit` detects any tampered or deleted receipt.
