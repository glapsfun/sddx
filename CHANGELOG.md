# Changelog

All notable changes to sddx are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and sddx adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0](https://github.com/glapsfun/sddx/compare/v1.1.0...v2.0.0) (2026-07-23)


### ⚠ BREAKING CHANGES

* `sddx config show --json` now emits the same versioned envelope as `--output json` (the resolved config moves under a `data` key instead of being the whole payload). `--json` still works as a deprecated alias with a stderr notice; prefer `--output json` going forward.

### Added

* add CLI output framework with --output json/markdown/all support ([4ecd168](https://github.com/glapsfun/sddx/commit/4ecd1680ff4aef767350a703b1abd07a7d6f82fe))

## [1.1.0](https://github.com/glapsfun/sddx/compare/v1.0.0...v1.1.0) (2026-07-22)


### Added

* add generalized config precedence resolver and sddx config commands ([68290c8](https://github.com/glapsfun/sddx/commit/68290c872da6cfa38a0885c23ee2f37257aa2857))

## [1.0.0](https://github.com/glapsfun/sddx/compare/v0.4.0...v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* the post-task completion message users see is now the Next Actions menu instead of free-form prose offering a merge.

### Added

* model single-parent task dependencies with scope-based scheduling ([4f91a48](https://github.com/glapsfun/sddx/commit/4f91a48aec545ee4f0fbf6d0460ed35b40ae7459))
* replace static task-completion message with a Next Actions menu ([6b98212](https://github.com/glapsfun/sddx/commit/6b982121d0238e11273a43b53a6b675e9d0bc981))

## [0.4.0](https://github.com/glapsfun/sddx/compare/v0.3.0...v0.4.0) (2026-07-20)


### Added

* publish sddx as a standalone CLI on npm ([f0c489b](https://github.com/glapsfun/sddx/commit/f0c489ba3c1c1a176e19ccbc8699f14b2c810986))
* publish sddx as a standalone CLI on npm ([628358d](https://github.com/glapsfun/sddx/commit/628358df925b23e94007278c7e0b3c3c2df85f66))

## [0.3.0](https://github.com/glapsfun/sddx/compare/v0.2.0...v0.3.0) (2026-07-20)


### Added

* automate releases with release-please and a required install smoke test ([076729b](https://github.com/glapsfun/sddx/commit/076729bc2f2f2be8b91c821805ebc6015fcbcc32))
* automate releases with release-please and a required install smoke test ([e32b406](https://github.com/glapsfun/sddx/commit/e32b40647507038988b46609484ff7791633182f))


### Fixed

* exempt bot-touched manifests from Biome's format check ([184530a](https://github.com/glapsfun/sddx/commit/184530a56975afeb6d68e97612397dcd3fba4061))
* exempt bot-touched manifests from Biome's format check ([2b9f878](https://github.com/glapsfun/sddx/commit/2b9f878b0562cd0f41a18161f07266971617d839))
* release-please tags must be bare v&lt;version&gt;, not sddx-v&lt;version&gt; ([6f295e6](https://github.com/glapsfun/sddx/commit/6f295e630384233e73c68ed5aac30105dccde482))
* release-please tags must be bare v&lt;version&gt;, not sddx-v&lt;version&gt; ([7c7089a](https://github.com/glapsfun/sddx/commit/7c7089ae17d6b7e062b881130a8e3fca0e59974a))

## [Unreleased]

### Added

- `sddx pr create --goal <goal-id>`: ships a completed `/sddx:run` goal as
  **one PR per goal**, gated on every task being DONE with a passing receipt.
  Builds the PR branch by cherry-picking each task's atomic commit (never a
  merge commit), pushes it, and opens the PR via `gh` or `glab`
  (auto-detected from the `origin` remote, or pinned with `userConfig.pr_host`)
  with a body generated from the tasks' receipts.
- `sddx goal create` / `sddx goal show`: persists `.sddx/goals/<goal-id>.json`
  tying a set of task ids together; `/sddx:run` registers one automatically.
- `/sddx:pr` skill for directly invoking `pr create`.
- Task state gains an optional `shipped` field, written once by `pr create`;
  `sddx cleanup` now accepts a `shipped` marker as proof-of-integration when
  a cherry-picked branch fails git's ancestry-based merge check.

## [0.2.0] - 2026-07-18

Trust hardening: prove the oracle, close the gate holes, extend receipt
trust beyond the local machine.

### Added

- Receipt v3: per-run `runs[]` records, `env` capture (runtime, OS, dirty
  tree), optional SSH `signature`/`signer`. Audit accepts v1–v3.
- `sddx red-check <id>`: the oracle must fail during RED; verify refuses
  tasks without pre-GREEN failing-oracle evidence.
- `oracle.runs: N` + userConfig `oracle_runs_default`: N-for-N oracle passes
  (flakiness detection).
- RED-phase Bash allow-list hook closes the `sed -i`/`tee`/redirection
  bypass (userConfig `red_bash_allow` extends the list).
- Stuck-loop detection: `stuck_threshold` identical failures → escalate
  instead of iterating; shown on the board as `⚠stuck`.
- `sddx audit --ci`: tamper-only CI gate with a zero-install workflow recipe.
- Comprehensive documentation: `docs/` guides (installation, usage, spec
  reference, hooks, CLI, receipts and audit, architecture, troubleshooting),
  community files, README landing page with status badges, and an offline
  link-check CI job.

## [0.1.0] - 2026-07-17

### Added

- `sddx board` and the generated `.sddx/BOARD.md` rollup, including a flagged
  section for dirty worktrees.
- `sddx audit [--signatures]`: receipt hash-chain verification, commit
  binding, and optional commit-signature checks; exit 1 on any finding.
- Marketplace distribution (`claude plugin marketplace add glapsfun/sddx`)
  and strict plugin validation in CI.
- Always-on token budget measured and gated in the test suite (< 500 tokens).
- Sweep results persisted to `.sddx/sweep.json`.

### Changed

- Verify skill cross-checks prose success criteria (explicitly non-binding);
  the receipt verdict stays oracle-exit-code-only.

## [0.0.3] - 2026-07-17

### Added

- Worktree workspaces: per-task worktrees under `.sddx-worktrees/` forked from
  `origin/HEAD`, with automatic downgrade to branch mode when submodules make
  worktrees unsafe.
- Lock-guarded orphan-worktree sweep (`sddx sweep`).
- Receipt hash tree: parallel tasks write sibling receipts sharing one parent.
- Role-restricted agents (orchestrator, planner, tdd-executor, verifier) and
  the `/sddx:run` orchestration skill.
- Hook-enforced TDD gate: RED-phase writes to implementation paths are
  hard-blocked (`PreToolUse`), with per-file audited `allow` exemptions.
- Test recorder (`PostToolUse`): observed test exit codes drive
  PLAN→RED→GREEN.
- Stop gate: sessions and subagents cannot conclude a task without a verified
  receipt.
- Receipt schema v2 with the `allow` field.

## [0.0.2] - 2026-07-17

### Added

- End-to-end milestone test covering the full task loop.
- Biome lint/format tooling, pre-commit gates (two stages), yamllint, and the
  CI lint job.
- Hardened bun-or-node launcher and a CI drift check for the committed
  `dist/` bundles.

## [0.0.1] - 2026-07-17

### Added

- Spec parser with mandatory oracle: a spec without an observable success
  signal is rejected (`no oracle, no goal`).
- Task state files with an evidence-gated phase machine
  (PLAN→RED→GREEN→REFACTOR→VERIFY→DONE).
- Immutable hash-chained receipts and chain verification.
- Verifier: executes the oracle and writes the receipt in one atomic commit
  (code + spec + receipt).
- `sddx` CLI: `task create`, `task phase`, `task allow`, `task show`,
  `verify`, `cleanup`.
- Plan, quick, and verify skills for the core task loop.
