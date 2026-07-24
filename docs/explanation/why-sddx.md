# Why sddx

**One sentence:** a fast, dense alternative to Superpowers — process over
intelligence, proof over promises.

sddx is a lightweight, loop-based Spec-Driven Development (SDD) framework,
shipped as a first-class Claude Code plugin. It turns vague development goals
into dense, machine-verifiable specs, executes them through strict
hook-enforced TDD across parallel git worktrees, and leaves behind a
tamper-evident audit trail of receipts inside the repository.

## The problem

Agentic dev frameworks suffer from five recurring failure modes:

- **Token bloat.** Large always-on skill libraries tax every session before
  any work starts.
- **Prompt-level discipline.** "Write the test first" is a request, not a
  rule — the model can and does skip it.
- **Unverifiable completion.** "Done" is a model claim, not an observable
  fact.
- **Transient state.** Progress lives in the chat session and dies with it.
- **Sequential compounding.** Consecutive tasks on one branch contaminate
  each other.

## The answer

| Problem                 | sddx mechanism                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------|
| Token bloat              | Minimal skill surface; lazy-loaded references; measured token budget                        |
| Prompt-level discipline  | **Hooks hard-block** implementation writes before a failing test exists                     |
| Unverifiable completion  | Every goal requires an **oracle** — an observable success signal; the verifier executes it  |
| Transient state          | Per-task JSON state + receipts committed **in the repo**; survives restarts and compaction  |
| Compounding tasks        | **Worktree-per-task** isolation, forked from `origin/HEAD`, parallel by default              |

The mechanisms themselves are covered task-by-task starting from
[docs/tutorials/01-getting-started.md](../tutorials/01-getting-started.md);
the reasoning behind each one is in
[design-principles.md](design-principles.md).

## Non-goals (v1)

- A live web UI board — sddx generates `BOARD.md` only.
- Support or testing for harnesses other than Claude Code (state formats stay
  harness-neutral; every receipt records `harness:`).
- Large-scale project management (epics, sprints). sddx targets small-to-medium
  tasks and batches of them.

## Success metrics

- Fresh install → first verified task in **< 10 minutes**.
- Always-on token cost **< ~500 tokens** per session (enforced in CI by
  `scripts/token-budget.ts`).
- The TDD gate integration suite: an implementation-first attempt is
  **always** blocked; a test-first path **always** passes.
- Two or more parallel tasks complete with **zero** merge conflicts in
  `.sddx/` and a valid receipt chain.
- `sddx audit` detects any tampered or deleted receipt.
