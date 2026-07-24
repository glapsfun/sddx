# Architecture

Contributor-facing map of the codebase: where things live, how sources become
the shipped bundles, and where state goes. Reader-facing behavior is
documented in the tutorials, how-to guides, and
[../reference/hooks.md](../reference/hooks.md); the reasoning behind each
design choice is in [design-principles.md](design-principles.md) and
[why-sddx.md](why-sddx.md).

## Layout

```
sddx/
├── .claude-plugin/plugin.json   # ONLY the manifest lives here (name, version, userConfig)
├── skills/                      # /sddx:run, quick, plan, verify, board, audit
├── agents/                      # orchestrator, planner, tdd-executor, verifier
├── hooks/hooks.json             # the five hook registrations
├── bin/sddx-run                 # POSIX launcher: prefer bun, fall back to node ≥18
├── src/                         # TypeScript sources (Bun toolchain)
│   └── lib/                     # spec, task, classify, receipt, verify, worktree, git…
├── dist/                        # committed dependency-free bundles: cli.mjs, hooks.mjs, bootstrap.mjs
├── scripts/                     # build.ts, token-budget.ts
└── tests/                       # bun test: unit + hook integration + e2e milestones
```

Claude Code plugin rules honored throughout: only the manifest inside
`.claude-plugin/`; skills (not legacy `commands/`); every script referenced as
`${CLAUDE_PLUGIN_ROOT}/dist/….mjs`; `claude plugin validate --strict` runs in
CI.

Role separation is enforced with tool restrictions, not prompting: the
`orchestrator` and `planner` agents have no source-edit tools, the
`tdd-executor` cannot merge or write receipts, and the `verifier` can run the
oracle and write the receipt but never edit sources.

## Runtime and build

- **Develop and test with Bun** (version pinned in `.bun-version`):
  `bun test`, `tsc --noEmit`, Biome for lint/format.
- **Ship dependency-free.** `bun run build` (`scripts/build.ts`) bundles each
  entry point into a single-file `dist/*.mjs` with zero runtime dependencies,
  and `dist/` is committed. npm packages exist only at build time; users
  install nothing.
- **Launch anywhere.** `bin/sddx-run` prefers `bun`, falls back to `node`
  ≥ 18, and refuses anything older — no other runtimes.
- **CI drift check.** CI rebuilds and fails if `dist/` doesn't match `src/`,
  so the committed bundles can be trusted.
- **Hot-path budget.** Hooks run on every session and every tool call:
  SessionStart bootstrap stays under 200 ms, no heavy imports on the hot path,
  and state/receipts are JSON so hook code parses them with zero libraries.
  The always-on skill surface is measured by `scripts/token-budget.ts` and
  gated in the test suite (< 500 tokens).

## State model

```
.sddx/
  drafts/<name>.yaml         # pre-registration graph.yaml + spec drafts (planner/orchestrator authored)
  context/<name>.md          # pre-registration research/context notes (planner authored)
  specs/<task-id>.yaml       # the registered spec (copied at task create)
  tasks/<task-id>.json       # phase, oracle, workspace, base SHA, allow list, iterations
  receipts/<task-id>.json    # immutable, written once by the verifier
  goals/<goal-id>.json       # task ids a /sddx:run goal ties together; read by `pr create`
  BOARD.md                   # generated rollup — never hand-edited
  config.json                # materialized from the plugin manifest's userConfig; read-only to sddx code
  sweep.json                 # last orphan-sweep result; read by the board's flagged-worktrees section
```

Every sddx-authored artifact — draft or registered — lives under `.sddx/`. A
few things intentionally live outside it because they aren't sddx state:

- **Worktrees** live under `.sddx-worktrees/<id>` on branch `sddx/<id>`,
  forked from `origin/HEAD`, not inside `.sddx/` — each is a real git worktree
  checkout, and nesting one inside `.sddx/` would break the per-task isolation
  `.sddx/` exists to keep conflict-free. The sweep and cleanup rules are
  documented in [../tutorials/02-your-first-parallel-run.md](../tutorials/02-your-first-parallel-run.md).
- **The sweep lock and `.git/info/exclude`'s `.sddx-worktrees/` entry** live
  under `.git/` — they're git-internal bookkeeping, not sddx state.

Two invariants hold across all of `.sddx/`:

- **One file per task** — parallel worktrees merge `.sddx/` without conflicts.
- **Every completed task is one atomic commit**: code + spec + receipt.

## Design principles

The tie-breakers for any design argument are covered in
[design-principles.md](design-principles.md) — this page stays focused on
where they land in the codebase.
