# Architecture

Contributor-facing map of the codebase: where things live, how sources become
the shipped bundles, where state goes, and the principles that decide design
arguments. Reader-facing behavior is documented in [usage.md](usage.md),
[hooks.md](hooks.md), and [receipts-and-audit.md](receipts-and-audit.md).

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
  specs/<task-id>.yaml       # the registered spec (copied at task create)
  tasks/<task-id>.json       # phase, oracle, workspace, base SHA, allow list, iterations
  receipts/<task-id>.json    # immutable, written once by the verifier
  goals/<goal-id>.json       # task ids a /sddx:run goal ties together; read by `pr create`
  BOARD.md                   # generated rollup — never hand-edited
```

- **One file per task** — parallel worktrees merge `.sddx/` without conflicts.
- **Every completed task is one atomic commit**: code + spec + receipt.
- **Worktrees** live under `.sddx-worktrees/<id>` on branch `sddx/<id>`,
  forked from `origin/HEAD`; the sweep and cleanup rules are documented in
  [usage.md](usage.md).

## Design principles

The tie-breakers for any design argument, in order of how often they settle
one:

1. **Process over intelligence.** Trust deterministic gates — hooks, schemas,
   exit codes — over model judgment.
2. **No oracle, no goal.** A spec without an observable success signal is
   rejected at plan time, mechanically.
3. **State is files in git.** If it isn't committed, it didn't happen.
4. **Hard rules, audited exceptions.** The only gate escape is per-file,
   written down, and surfaced in the receipt and on the board.
5. **Pay for what you use.** Subagents and worktrees only when the task
   warrants them; `--solo` exists for a reason.
6. **Zero trust in "done".** Completion is a verifier executing the oracle and
   writing a chained receipt — never a model claim.
