# Architecture

Contributor-facing map of the codebase: where things live, how the layers fit,
and where state goes. Behavior is documented in the
[reference](../reference/cli.md); the reasoning behind the design is in
[design-principles.md](design-principles.md).

## Three layers

```
 +--------------------------------------------------------------+
 | L3  skills        markdown the harness reads: brainstorm,    |
 |                   plan, execute, review, debug, finish       |
 +--------------------------------------------------------------+
 | L2  plugins       one per harness: install, session-start    |
 |                   context, hook registrations                |
 +--------------------------------------------------------------+
 | L1  core          the sddx CLI plus git: spec and plan       |
 |                   checks, approval, worktrees, the boundary  |
 |                   proof, review binding, receipts, audit     |
 +--------------------------------------------------------------+
```

The rule that shapes everything: **every guarantee is enforceable at L1 alone.**
An approved plan, an oracle that fails before and passes after the change, a
review bound to the exact merged diff, a tamper-evident receipt: all of these
hold with no harness present, which is what lets the same repository work in
any harness and in CI. Hooks (L2) add early feedback and the user's own
permission dialog; they are never the only thing enforcing a rule.

This repository holds L1, the hook handlers it exposes (`sddx hook <name>`), and
the frozen knowledge `sddx migrate` needs about sddx 5. The plugins and skills
live with their harness integrations.

## Layout

```
sddx/
├── bin/sddx, bin/sddx-run       # launcher: Bun required, no fallback
├── src/
│   ├── cli.ts                   # command routing and output
│   ├── board.ts, audit.ts       # BOARD.md rendering, receipt audit
│   ├── tdd-gate.ts              # strict-profile write gate
│   └── lib/
│       ├── goalspec.ts          # markdown goal spec parser
│       ├── plan.ts              # plan rules, plan resolution, plan start
│       ├── approval.ts          # plan hash, approval tokens, autonomy bounds
│       ├── lifecycle.ts         # task start, ready, abandon
│       ├── task.ts              # task state and transitions
│       ├── proof.ts, verify.ts  # verified tree, boundary proof, sddx verify
│       ├── review.ts, finalize.ts # review binding, receipt + commit + merge
│       ├── receipt.ts           # receipt schema 1 to 5, the hash chain
│       ├── approvalgate.ts, protectedpaths.ts, bashgate.ts, recorder.ts, stopgate.ts
│       ├── hookdispatch.ts      # `sddx hook <name>`: event JSON in, decision out
│       ├── migrate.ts           # sddx 5 to 6
│       └── legacy/              # what sddx 5 generated, frozen for migrate
├── dist/                        # committed dependency-free bundles
├── scripts/                     # build, spec coverage, v5 fixture builder
└── tests/                       # bun test: unit, CLI scenarios, e2e
```

## Runtime and build

- Develop and test with Bun (version pinned in `.bun-version`): `bun test`,
  `tsc --noEmit`, Biome.
- `bun run build` bundles each entry point into a single dependency-free
  `dist/*.mjs`, and `dist/` is committed. CI rebuilds and fails if `dist/`
  drifts from `src/`.
- Hooks run on every session and tool call, so their handlers stay cheap: in the
  default profile the gate handlers return before reading any task state.

## State model

```
.sddx/
  config.json               # reviewed policy; tool writes are denied
  specs/<goal-id>.md        # goal specs; the goal id is the file name
  approvals/<plan-hash>.json# approval tokens, content-addressed by the spec's sha256
  tasks/<id>.json           # PLANNED and ABANDONED tasks; a started task's file lives in its worktree
  receipts/<id>.json        # immutable, written once at finalize, hash-chained
  BOARD.md                  # generated
  sweep.json                # what the last sweep refused to remove
  legacy/                   # sddx 5 state archived by `sddx migrate`
  local/                    # machine-local, gitignored
```

Outside `.sddx/`:

- **Run branch** `sddx/run-<goal-id>`: created by `plan start` at the base
  commit, with one commit holding the approved spec bytes. Finalized tasks are
  merged into it with `git merge --no-ff`. Merging it into the target branch is
  always a person's decision.
- **Task worktrees** `.sddx-worktrees/<id>` on branch `sddx/<id>`: created by
  `task start`. A root forks from the run branch head; a dependent forks from its
  parents' `DONE` commits. The task's state file lives here while it is started.
  The finalize commit carries the verified tree, the state and the receipt
  together; abandoning moves the state back to the main checkout. Either way a
  finished task's worktree holds nothing it alone records, and sweep removes it
  once nothing in it is uncommitted.
- **Proof worktrees** `.sddx-worktrees/<id>--proof`: detached, created and
  removed by one `sddx verify`, and locked to that process. A killed verify can
  leave one behind; the sweep removes it once its owner is gone.
- **Proof records** `.git/sddx-proofs/<id>.json`: what a passing `verify` proved,
  kept in the git directory, outside every worktree and every commit. Review
  and finalize trust only this record, never the task file's copy.
- **Goal records** live in the git ref `refs/sddx/goals/<goal-id>`, pointing at a
  JSON blob: not carried by merges or branch deletions, written with
  compare-and-swap through `git update-ref`, pushed explicitly by `pr create`.

Two invariants hold across all of it:

- **One state file per task**, so parallel worktrees never edit the same file.
- **Every finalized task is one commit**: code, task state and receipt.

## Verification and review

`sddx verify` snapshots the task worktree's content into a git tree using a
temporary index (neither the files nor the real index change), checks scope,
then runs the boundary proof in the proof worktree: RED on the base commit plus
the changed test files, GREEN on the verified tree. See
[verification.md](../reference/verification.md).

`sddx review record` snapshots the tree again and refuses if it changed, stores
the sha256 of the verified diff, and on a pass finalizes: one commit, a version 5
receipt, the merge into the run branch. sddx cannot judge whether a review was
good; it makes "a passing review of exactly the merged diff" a recorded fact.
