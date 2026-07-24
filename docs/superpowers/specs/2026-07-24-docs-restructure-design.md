# Design: Diataxis docs restructure + runnable examples for sddx

## Problem

sddx has a solid reference doc set (`docs/installation.md`, `usage.md`,
`spec-reference.md`, `hooks.md`, `cli.md`, `receipts-and-audit.md`,
`architecture.md`, `troubleshooting.md`) plus a pitch in `README.md`. Two gaps:

- **No examples.** Nothing lets a reader copy a working scaffold and run it
  against the real CLI. The README quickstart is the only runnable thing,
  and it covers exactly one feature (a single command-oracle task).
- **No structure by reader intent.** Docs are a flat list. A reader learning
  sddx for the first time, one looking up a CLI flag, and one wanting to
  understand *why* sddx exists all land in the same undifferentiated table.
- **Newest feature undocumented.** Multi-parent DAG dependencies with
  retry/skip policy (the most recent commit) exists only as a paragraph in
  `architecture.md`.

## Goals

- Reorganize `docs/` around reader intent using the Diataxis framework:
  tutorials (learning), how-to guides (tasks), reference (lookup),
  explanation (understanding).
- Add a `examples/` tree of runnable scaffolds — one per major feature —
  that a reader can literally `cd` into and run against the real `sddx` CLI.
- Verify every example in CI so a doc claim that stops being true is a build
  failure, not silent rot — consistent with sddx's own "proof over promises"
  principle.
- Cover all nine major feature surfaces (enumerated below) in the examples.
- Keep everything as plain Markdown + real spec/graph YAML files. No docs
  site generator, no new runtime devDependency — consistent with sddx's
  zero-footprint philosophy.

## Non-goals

- No generated static site (VitePress/Docusaurus/mkdocs) — plain
  GitHub-rendered Markdown only.
- No compat stubs at old `docs/*.md` paths — this is a same-repo
  reorganization with no external SEO/link surface to preserve.
- `docs/RELEASING.md` is untouched — it's a maintainer doc, not part of the
  reader-facing structure this design covers.

## Target structure

```
docs/
  tutorials/                       # learning-oriented, hand-held, linear
    01-getting-started.md          # single task, --solo, in-place
    02-your-first-parallel-run.md  # two tasks via /sddx:run across worktrees

  how-to/                          # task-oriented recipes, assume basic familiarity
    install-sddx.md                # moved from docs/installation.md
    model-dag-dependencies.md      # fan-out/fan-in, overlap⇒ordered scope gate
    configure-retry-and-skip.md    # retry.max_attempts, on_dependency_failure
    use-branch-mode.md             # submodule fallback, sddx/<task-id> branches
    choose-an-oracle-type.md       # command / test-suite / browser / manual
    verify-and-audit-receipts.md   # inspecting chain, signing, breaking + catching
    ship-a-goal-as-a-pr.md         # sddx pr create
    tune-config.md                 # userConfig walkthrough
    troubleshoot-common-problems.md # moved from docs/troubleshooting.md

  reference/                       # information-oriented, exhaustive, no narrative
    spec-reference.md              # moved verbatim; extended for depends_on/retry/on_dependency_failure
    cli.md                         # moved verbatim
    hooks.md                       # moved verbatim
    receipts-schema.md             # schema portion split out of receipts-and-audit.md
    config.md                      # NEW — userConfig field-by-field reference

  explanation/                     # understanding-oriented, the "why"
    why-sddx.md                    # problem/answer table, one-sentence pitch (adapted from CLAUDE.md)
    design-principles.md           # process over intelligence, no oracle/no goal, etc.
    how-it-compares.md             # vs Superpowers, BMAD, Blueprint, GoalBuddy, gsd-core
    architecture.md                # moved verbatim

  RELEASING.md                     # unchanged, maintainer-only

examples/
  01-single-task/
  02-parallel-run/
  03-dag-dependencies/
  04-retry-and-skip/
  05-branch-mode/
  06-oracle-types/
  07-receipts-and-audit/
  08-pr-from-goal/
  09-config-tuning/
  README.md                        # index, links each entry to its tutorial/how-to doc
```

Every tutorial/how-to guide with a runnable counterpart links straight to its
`examples/NN-*/` directory. Reference and explanation docs are read, not run,
and get no example scaffold.

## Migration mapping (existing → new)

| Current file | Fate |
|---|---|
| `docs/installation.md` | Move to `how-to/install-sddx.md`, kept largely as-is |
| `docs/usage.md` | Split: conceptual task-loop material folds into `explanation/design-principles.md`; the `/sddx:run` vs `/sddx:quick` how-do-I-run-this material expands into the two tutorials |
| `docs/spec-reference.md` | Move to `reference/spec-reference.md`, verified up to date against the current spec schema (`depends_on`, `retry`, `on_dependency_failure`) |
| `docs/hooks.md` | Move to `reference/hooks.md` verbatim |
| `docs/cli.md` | Move to `reference/cli.md` verbatim |
| `docs/receipts-and-audit.md` | Split: schema → `reference/receipts-schema.md`; inspect/sign/audit procedure → `how-to/verify-and-audit-receipts.md` |
| `docs/architecture.md` | Move to `explanation/architecture.md` verbatim |
| `docs/troubleshooting.md` | Move to `how-to/troubleshoot-common-problems.md` verbatim |
| `docs/RELEASING.md` | Unchanged |
| — | NEW: `reference/config.md` (userConfig today only documented as doc-comments in `plugin.json`) |
| — | NEW: `explanation/why-sddx.md`, `explanation/how-it-compares.md` (adapted from CLAUDE.md §1–3) |

Old `docs/*.md` paths are deleted, not redirected.

## Example feature coverage (v1: all nine)

1. **Single task loop** — `/sddx:quick`, `--solo`, in-place, no worktree
2. **Parallel multi-task run** — `/sddx:run`, independent tasks across worktrees
3. **DAG dependencies** — `depends_on` fan-out/fan-in, materialize-on-all-parents-done, overlap⇒ordered scope gate
4. **Retry & skip/block policy** — `retry.max_attempts`/`workspace`, `on_dependency_failure: skip|block`
5. **Branch mode** — submodule auto-fallback, `sddx/<task-id>` branches
6. **Oracle types** — command / test-suite / browser / manual, all four in practice
7. **Receipts, hash chain & audit** — inspecting a receipt, signing, deliberately breaking the chain and catching it with `/sddx:audit`
8. **Ship as PR** — `sddx pr create` from a DONE goal
9. **Config tuning** — `userConfig` fields in practice (`workspace_mode`, `stuck_threshold`, `agent_model`, `prefer_solo`, `--output json|markdown`, etc.)

## Example scaffold shape

```
examples/03-dag-dependencies/
  README.md          # narrative + exact ```sh commands to run + expected output
  setup.sh            # idempotent: git init + empty commit; takes optional target dir
  specs/
    task-a.yaml
    task-b.yaml
    task-c.yaml       # depends_on: [task-a, task-b] — the fan-in case
  graph.yaml           # depends_on edges (graph-level, not in-spec)
```

`README.md` is both the human-facing doc and the literal script CI replays:
every fenced ```sh block is the single source of truth for both, so prose and
reality can't drift apart independently.

`setup.sh` accepts a target directory argument:
- **Local use:** defaults to a gitignored `examples/NN-*/.sandbox/`, so a
  contributor can run `./setup.sh` in place with no `cd` gymnastics.
- **CI use:** CI passes an external `mktemp -d` path, so the sddx repo's own
  git state is never touched by example runs.

## CI verification

New CI job, `examples`, added to `.github/workflows/ci.yml`, running after
the existing build/test jobs (it needs `dist/cli.mjs` built first):

1. Build `dist/cli.mjs` fresh — examples run against the real published
   surface, not source.
2. For each `examples/NN-*/`: run `setup.sh <tmpdir>`, then extract and
   execute each fenced ```sh block from that example's `README.md` in order,
   inside `<tmpdir>`.
3. Assert outcomes:
   - Exit codes match what's documented (a fenced block may carry an
     adjacent `<!-- expect: exit N -->` marker).
   - For oracle/receipt-producing steps: assert the receipt file exists and
     `sddx audit` passes (or, for example 7, deliberately fails as the
     narrative demonstrates).
4. Any mismatch fails the job with the example name and the failing command
   — loud, not silent.

## Out of scope / deferred

- No docs-site build pipeline.
- No redirect stubs for old paths.
- Nothing beyond the nine listed examples for v1 — further feature coverage
  (if sddx grows new capabilities) is a fast-follow, not part of this change.
