# Changelog

All notable changes to sddx are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and sddx adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.0.0](https://github.com/glapsfun/sddx/compare/v4.0.0...v5.0.0) (2026-08-02)


### ⚠ BREAKING CHANGES

* retire plugin distribution and rewrite the docs around it
* require Bun, own the config schema in the CLI
* removes /sddx:quick, --solo, prefer_solo, task create, goal create, --workspace, --no-branch, workspace_mode, and the branch/none workspace modes. `graph create` is the only creation surface.
* a graph with `tasks:` must carry `schema_version` and `interaction_mode`; see docs/reference/config.md for the migration.
* `sddx next-actions` now requires `--goal <goal-id>`. The current-branch menu and its action catalog are removed.
* an auto-mode plan over a bound now exits non-zero instead of exit 3, and cannot be approved past. Set "execution_mode": "human" in .sddx/config.json to review and run it. Approval tokens no longer record requested_mode or degraded_reason; existing tokens carrying them still parse.
* `sddx config show --json` now emits the same versioned envelope as `--output json` (the resolved config moves under a `data` key instead of being the whole payload). `--json` still works as a deprecated alias with a stderr notice; prefer `--output json` going forward.
* the post-task completion message users see is now the Next Actions menu instead of free-form prose offering a merge.

### Added

* add .agents and AGENTS.md to .gitignore ([bd2a11f](https://github.com/glapsfun/sddx/commit/bd2a11fff45431189c5ec066f6f17ec5d7f5ad66))
* add bun toolchain and bootstrap module ([125348f](https://github.com/glapsfun/sddx/commit/125348fdcb62cb059c711a9c7b61e0545e6f67af))
* add CLI output framework with --output json/markdown/all support ([4ecd168](https://github.com/glapsfun/sddx/commit/4ecd1680ff4aef767350a703b1abd07a7d6f82fe))
* add example-verification harness for docs/examples ([19a59e8](https://github.com/glapsfun/sddx/commit/19a59e8d1fd5cab81530eaeb8e1efc4cdb0e05c5))
* add generalized config precedence resolver and sddx config commands ([68290c8](https://github.com/glapsfun/sddx/commit/68290c872da6cfa38a0885c23ee2f37257aa2857))
* add human/auto execution modes with a deterministic approval gate ([90d546b](https://github.com/glapsfun/sddx/commit/90d546b0f1b751e362d60c0fa425379ea9fa3a25))
* add human/auto execution modes with a deterministic approval gate ([477b309](https://github.com/glapsfun/sddx/commit/477b309c9426283cb5355558d4e650c6c83ccf54))
* add launcher shim and committed dist bundle ([44cfc4a](https://github.com/glapsfun/sddx/commit/44cfc4a9ac31ded4e74547238cbed3be4c2d1e38))
* add optional user-global state at ~/.sddx ([638ca63](https://github.com/glapsfun/sddx/commit/638ca63945b61d3bda58de57e78c39b46ef71457))
* add plugin manifest and quick skill stub ([6c7f3ce](https://github.com/glapsfun/sddx/commit/6c7f3cebe04defa6cbd91ebc145e22c84e97bbf2))
* add sddx doctor ([bc6b151](https://github.com/glapsfun/sddx/commit/bc6b1514f204c55916b48a359ede1a4001ada5a2))
* add sddx init, the plan-then-apply bootstrap ([6815479](https://github.com/glapsfun/sddx/commit/68154799e7b486d844cc6237b8ba2d4ab0c4be88))
* add the Clack initializer ([9de4c78](https://github.com/glapsfun/sddx/commit/9de4c783127a6c053c3c9921bb2376a23a32fde8))
* add the project-adapter contract and the Claude adapter ([aefbff4](https://github.com/glapsfun/sddx/commit/aefbff40a9b46c5d7383b5cc13405668615e19a5))
* audit --ci — tamper-only receipt gate for pull requests ([4f7c775](https://github.com/glapsfun/sddx/commit/4f7c775998adf57c78adb382abbd1757c9a96375))
* automate releases with release-please and a required install smoke test ([076729b](https://github.com/glapsfun/sddx/commit/076729bc2f2f2be8b91c821805ebc6015fcbcc32))
* automate releases with release-please and a required install smoke test ([e32b406](https://github.com/glapsfun/sddx/commit/e32b40647507038988b46609484ff7791633182f))
* canonical run lifecycle, sections 1-4 ([b45001c](https://github.com/glapsfun/sddx/commit/b45001c4f004363cf2c0a3eda11c0e1957a37676))
* canonical run lifecycle, sections 1-4 ([cbd22b5](https://github.com/glapsfun/sddx/commit/cbd22b5812968fc78b206069ab1df7e8c3c3d8f0))
* close concept gaps — token budget gate, board worktree flags, criteria semantics ([2513eea](https://github.com/glapsfun/sddx/commit/2513eeab892856b68121dca4669fcb1a42465c67))
* commit the goal record to its run branch ([98c8d22](https://github.com/glapsfun/sddx/commit/98c8d220954203d9af679ece49369e2320deb541))
* complete the canonical initializer's preflight and add rollback ([cd45f4e](https://github.com/glapsfun/sddx/commit/cd45f4e4ad50589a2144cb3be72efb2f7ab029dd))
* end-to-end milestone test and version bump to 0.0.2 ([df0d758](https://github.com/glapsfun/sddx/commit/df0d758f16a3b91f0b85978663c298b4342626c4))
* extend task dependencies to a multi-parent DAG with retry and skip policy ([ecc7e64](https://github.com/glapsfun/sddx/commit/ecc7e643a08870ad8699359441ed25636ead2685))
* git helpers for branch mode and atomic commits ([a396b17](https://github.com/glapsfun/sddx/commit/a396b1776203f09c6a094abaa705a486c0eb1ec8))
* immutable hash-chained receipts with chain verification ([3962270](https://github.com/glapsfun/sddx/commit/3962270c56bc37a8f09f92cf9b1d071ea83593b4))
* interaction modes, an intake round, and a plan-review gate ([1f6f983](https://github.com/glapsfun/sddx/commit/1f6f98376f0587ae840d2e8477ad71524646913c))
* M2 milestone — parallel worktree e2e proof and version 0.0.3 ([107d125](https://github.com/glapsfun/sddx/commit/107d1251086ce6ad16446934cb2d73b02704c470))
* M3 milestone — hook-enforced TDD gate, test recorder, stop gate, and receipt v2 ([e601d22](https://github.com/glapsfun/sddx/commit/e601d22e4d0767ac319be1ef3a9b0fa24701efad))
* M4 milestone — board, audit, docs, and marketplace distribution for v0.1.0 ([44949fe](https://github.com/glapsfun/sddx/commit/44949fe2701655dd23c482c78a474557d343c888))
* model single-parent task dependencies with scope-based scheduling ([4f91a48](https://github.com/glapsfun/sddx/commit/4f91a48aec545ee4f0fbf6d0460ed35b40ae7459))
* one authoritative run summary and one goal-scoped handoff ([86ec3f2](https://github.com/glapsfun/sddx/commit/86ec3f2c5a10ed09b78c37c0b63faa0d7fe15e37))
* oracle red-check — verify demands proof the oracle can fail ([ea63ce3](https://github.com/glapsfun/sddx/commit/ea63ce34f00c00fa87b568973fe93b49f4e7ee7f))
* oracle.runs — N-run flakiness detection in verify ([214d333](https://github.com/glapsfun/sddx/commit/214d333f10866f2229a07f76079456c3c7d109af))
* plan, quick, and verify skills for the core task loop ([3e9ae70](https://github.com/glapsfun/sddx/commit/3e9ae702550f59543aafa19ba52ad71dcc1fc3c1))
* pre-commit gates, yamllint config, and ci lint job ([b0a534b](https://github.com/glapsfun/sddx/commit/b0a534bd13b8ebbb846fd5a1c174d1770a373974))
* publish sddx as a standalone CLI on npm ([f0c489b](https://github.com/glapsfun/sddx/commit/f0c489ba3c1c1a176e19ccbc8699f14b2c810986))
* publish sddx as a standalone CLI on npm ([628358d](https://github.com/glapsfun/sddx/commit/628358df925b23e94007278c7e0b3c3c2df85f66))
* receipt v3 — per-run records and environment capture ([567037c](https://github.com/glapsfun/sddx/commit/567037cb7479b645955e299f3ec58898d53ba98e))
* RED-phase Bash allow-list gate closes the shell write bypass ([f945652](https://github.com/glapsfun/sddx/commit/f945652079b2b506cd0ca3eedbf9b2b05a06341a))
* refuse autonomy bounds instead of degrading auto into human ([910d8f2](https://github.com/glapsfun/sddx/commit/910d8f2ea6b926b6de831ef41ad3f0e7d2e67708))
* replace goal-PR cherry-picking with a continuously-merged run branch ([1a0a121](https://github.com/glapsfun/sddx/commit/1a0a1210ba1a894b9345f24b24918435dd99d901))
* replace static task-completion message with a Next Actions menu ([6b98212](https://github.com/glapsfun/sddx/commit/6b982121d0238e11273a43b53a6b675e9d0bc981))
* require Bun, own the config schema in the CLI ([0bdc261](https://github.com/glapsfun/sddx/commit/0bdc2617dc6ee90f2be65b964066db99643fec51))
* retire alternate execution flows ([61d234a](https://github.com/glapsfun/sddx/commit/61d234a506daa7a3593784daa15b202c6f8ab906))
* retire plugin distribution and rewrite the docs around it ([3892ad9](https://github.com/glapsfun/sddx/commit/3892ad9bbab0d538972de99ca925685fecee19ef))
* role-restricted agents and /sddx:run orchestration skill ([9ae3636](https://github.com/glapsfun/sddx/commit/9ae36366ace8810b99aff3ee825244637f379ab6))
* sddx cli with task, verify, and cleanup commands ([b51dbaa](https://github.com/glapsfun/sddx/commit/b51dbaaa57dee6901937a0e4d3f6489b926386e6))
* sddx pr create — ship a goal as one PR of cherry-picked task commits ([63bc22f](https://github.com/glapsfun/sddx/commit/63bc22fcc0cf782f3b3ffac005975558a439f6eb))
* spec parser rejects specs without an oracle ([fbe758a](https://github.com/glapsfun/sddx/commit/fbe758ab66fc6b48fd1555909caad5103cc45052))
* SSH-signed receipts with audit-time verification ([41df4a6](https://github.com/glapsfun/sddx/commit/41df4a6a36fa1b085a0ff805497c5c7e8d2e21d6))
* stuck-loop detection — identical-failure fingerprints trigger escalation ([ecdcc72](https://github.com/glapsfun/sddx/commit/ecdcc72bf1b488a3eacfc8c54738f4de4484cb46))
* task state file and evidence-gated phase machine ([a280e00](https://github.com/glapsfun/sddx/commit/a280e003a87bf9e360d117b166c4a8ba7c21e51a))
* v0.2.0 — trust hardening release ([3e35295](https://github.com/glapsfun/sddx/commit/3e35295b3d0b73500d470a7372e1085c4517a94e))
* verifier executes oracle and writes chained receipt in atomic commit ([cd5f8a2](https://github.com/glapsfun/sddx/commit/cd5f8a2aa69811d11bc48d1e6446403655442dd2))
* worktree workspaces, orphan sweep, and receipt hash tree ([279b055](https://github.com/glapsfun/sddx/commit/279b0550dd477ac6a0ea76775896108bd5d9f600))


### Fixed

* address code-review findings on the canonical lifecycle branch ([fee6f3b](https://github.com/glapsfun/sddx/commit/fee6f3b9a5b42dc91dffdabfea382c743e640a16))
* **ci:** rebuild the release smoke test around the published package ([cb28542](https://github.com/glapsfun/sddx/commit/cb285427ff93410fd39f7ef08727449ba96df3e8))
* **ci:** rebuild the release smoke test around the published package ([f7c6cab](https://github.com/glapsfun/sddx/commit/f7c6cab1fd70029d6dbca989524dc6ba087012fc))
* close approval-gate bypasses found reviewing the execution-modes work ([148fef0](https://github.com/glapsfun/sddx/commit/148fef025b93aa91bf856f403863022542b18baa))
* close Bash-gate bypasses and verify guards found in review ([85e6db2](https://github.com/glapsfun/sddx/commit/85e6db23d1d769897da365e53927cf053d7061c1))
* close data-loss and crash paths found in review ([bd59326](https://github.com/glapsfun/sddx/commit/bd59326cd17ea315184c4d4352db843cac06c30e))
* close gate bypasses and false alarms found reviewing the first fix ([fa89a6a](https://github.com/glapsfun/sddx/commit/fa89a6a0b04c38e96a7d3e2cc753129e398d39d8))
* close two escapes in the auto-mode protected-path bound ([61de187](https://github.com/glapsfun/sddx/commit/61de187f03aa3e70b20fedf0c4869353647f23f4))
* exempt bot-touched manifests from Biome's format check ([184530a](https://github.com/glapsfun/sddx/commit/184530a56975afeb6d68e97612397dcd3fba4061))
* exempt bot-touched manifests from Biome's format check ([2b9f878](https://github.com/glapsfun/sddx/commit/2b9f878b0562cd0f41a18161f07266971617d839))
* harden launcher, CI drift check, and test suite ([a94db38](https://github.com/glapsfun/sddx/commit/a94db38a9d6bd22c2bfd6887bb803e28eace6e50))
* keep the board readable on legacy task state ([b42fe80](https://github.com/glapsfun/sddx/commit/b42fe807b95f7cda777f3ab546bc4130bd1bb99f))
* keep the board readable on task state the write path no longer produces ([c612156](https://github.com/glapsfun/sddx/commit/c6121568afda410353ed76c142a892d044ce44dc))
* make worktree preconditions precise, since they are now fatal ([e1cc204](https://github.com/glapsfun/sddx/commit/e1cc204a7b7dee7f0e419f13ed044772650f0f74))
* release-please tags must be bare v&lt;version&gt;, not sddx-v&lt;version&gt; ([6f295e6](https://github.com/glapsfun/sddx/commit/6f295e630384233e73c68ed5aac30105dccde482))
* release-please tags must be bare v&lt;version&gt;, not sddx-v&lt;version&gt; ([7c7089a](https://github.com/glapsfun/sddx/commit/7c7089ae17d6b7e062b881130a8e3fca0e59974a))
* stop a deferred dependent claiming the user's own checkout ([03c1ef9](https://github.com/glapsfun/sddx/commit/03c1ef9ad4021ab313569ec247344a8df78e6873))
* **tests:** give the example replays an explicit timeout ([f204fb9](https://github.com/glapsfun/sddx/commit/f204fb9ca3faa35d57af5d8e24acb53cb234a8e2))

## [4.0.0](https://github.com/glapsfun/sddx/compare/v3.0.0...v4.0.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* a graph with `tasks:` must carry `schema_version` and `interaction_mode`; see docs/reference/config.md for the migration.

### Added

* interaction modes, an intake round, and a plan-review gate ([1f6f983](https://github.com/glapsfun/sddx/commit/1f6f98376f0587ae840d2e8477ad71524646913c))


### Fixed

* close two escapes in the auto-mode protected-path bound ([61de187](https://github.com/glapsfun/sddx/commit/61de187f03aa3e70b20fedf0c4869353647f23f4))

## [3.0.0](https://github.com/glapsfun/sddx/compare/v2.3.0...v3.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* `sddx next-actions` now requires `--goal <goal-id>`. The current-branch menu and its action catalog are removed.
* an auto-mode plan over a bound now exits non-zero instead of exit 3, and cannot be approved past. Set "execution_mode": "human" in .sddx/config.json to review and run it. Approval tokens no longer record requested_mode or degraded_reason; existing tokens carrying them still parse.

### Added

* canonical run lifecycle, sections 1-4 ([b45001c](https://github.com/glapsfun/sddx/commit/b45001c4f004363cf2c0a3eda11c0e1957a37676))
* canonical run lifecycle, sections 1-4 ([cbd22b5](https://github.com/glapsfun/sddx/commit/cbd22b5812968fc78b206069ab1df7e8c3c3d8f0))
* commit the goal record to its run branch ([98c8d22](https://github.com/glapsfun/sddx/commit/98c8d220954203d9af679ece49369e2320deb541))
* complete the canonical initializer's preflight and add rollback ([cd45f4e](https://github.com/glapsfun/sddx/commit/cd45f4e4ad50589a2144cb3be72efb2f7ab029dd))
* one authoritative run summary and one goal-scoped handoff ([86ec3f2](https://github.com/glapsfun/sddx/commit/86ec3f2c5a10ed09b78c37c0b63faa0d7fe15e37))
* refuse autonomy bounds instead of degrading auto into human ([910d8f2](https://github.com/glapsfun/sddx/commit/910d8f2ea6b926b6de831ef41ad3f0e7d2e67708))


### Fixed

* address code-review findings on the canonical lifecycle branch ([fee6f3b](https://github.com/glapsfun/sddx/commit/fee6f3b9a5b42dc91dffdabfea382c743e640a16))
* keep the board readable on legacy task state ([b42fe80](https://github.com/glapsfun/sddx/commit/b42fe807b95f7cda777f3ab546bc4130bd1bb99f))
* keep the board readable on task state the write path no longer produces ([c612156](https://github.com/glapsfun/sddx/commit/c6121568afda410353ed76c142a892d044ce44dc))
* make worktree preconditions precise, since they are now fatal ([e1cc204](https://github.com/glapsfun/sddx/commit/e1cc204a7b7dee7f0e419f13ed044772650f0f74))
* stop a deferred dependent claiming the user's own checkout ([03c1ef9](https://github.com/glapsfun/sddx/commit/03c1ef9ad4021ab313569ec247344a8df78e6873))

## [2.3.0](https://github.com/glapsfun/sddx/compare/v2.2.0...v2.3.0) (2026-07-27)


### Added

* add human/auto execution modes with a deterministic approval gate ([90d546b](https://github.com/glapsfun/sddx/commit/90d546b0f1b751e362d60c0fa425379ea9fa3a25))
* add human/auto execution modes with a deterministic approval gate ([477b309](https://github.com/glapsfun/sddx/commit/477b309c9426283cb5355558d4e650c6c83ccf54))


### Fixed

* close approval-gate bypasses found reviewing the execution-modes work ([148fef0](https://github.com/glapsfun/sddx/commit/148fef025b93aa91bf856f403863022542b18baa))
* close gate bypasses and false alarms found reviewing the first fix ([fa89a6a](https://github.com/glapsfun/sddx/commit/fa89a6a0b04c38e96a7d3e2cc753129e398d39d8))

## [2.2.0](https://github.com/glapsfun/sddx/compare/v2.1.0...v2.2.0) (2026-07-26)


### Added

* add .agents and AGENTS.md to .gitignore ([bd2a11f](https://github.com/glapsfun/sddx/commit/bd2a11fff45431189c5ec066f6f17ec5d7f5ad66))
* replace goal-PR cherry-picking with a continuously-merged run branch ([1a0a121](https://github.com/glapsfun/sddx/commit/1a0a1210ba1a894b9345f24b24918435dd99d901))

## [2.1.0](https://github.com/glapsfun/sddx/compare/v2.0.0...v2.1.0) (2026-07-24)


### Added

* add example-verification harness for docs/examples ([19a59e8](https://github.com/glapsfun/sddx/commit/19a59e8d1fd5cab81530eaeb8e1efc4cdb0e05c5))
* extend task dependencies to a multi-parent DAG with retry and skip policy ([ecc7e64](https://github.com/glapsfun/sddx/commit/ecc7e643a08870ad8699359441ed25636ead2685))

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
