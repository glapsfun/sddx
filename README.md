# sddx

[![ci](https://img.shields.io/github/actions/workflow/status/glapsfun/sddx/ci.yml?branch=main&label=ci)](https://github.com/glapsfun/sddx/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fglapsfun%2Fsddx%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=version)](https://github.com/glapsfun/sddx)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![typescript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Loop-based Spec-Driven Development for Claude Code: dense specs with mandatory
oracles, hook-enforced TDD, parallel git worktrees, and hash-chained receipts.
Process over intelligence, proof over promises.

| Problem with agentic dev frameworks | sddx mechanism                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Token bloat             | Minimal skill surface; lazy-loaded references; measured token budget                       |
| Prompt-level discipline | **Hooks hard-block** implementation writes before a failing test exists                    |
| Unverifiable completion | Every goal requires an **oracle** — an observable success signal; the verifier executes it |
| Transient state         | Per-task JSON state + receipts committed **in the repo**; survives restarts and compaction |
| Compounding tasks       | **Worktree-per-task** isolation, forked from `origin/HEAD`, parallel by default            |

## Install

For Claude Code, as a plugin:

```sh
claude plugin marketplace add glapsfun/sddx
claude plugin install sddx@sddx
```

For direct/standalone use — CI pipelines, other agent harnesses, or just the
CLI by hand — independent of Claude Code, via npm/npx/bun:

```sh
npx @glapsfun/sddx board          # no install
npm install -g @glapsfun/sddx     # or: bun add -g @glapsfun/sddx
```

Both paths install the same `sddx` command (the package is scoped as
`@glapsfun/sddx` on npm, but its `bin` entry is plain `sddx`) — the plugin
wraps it with Claude Code skills and hooks; the npm package is the bare CLI.

Local development, skills-only mode, prerequisites, and verifying the install:
see [docs/how-to/install-sddx.md](docs/how-to/install-sddx.md).

## Quickstart (first verified task in ~5 minutes)

```sh
mkdir demo && cd demo && git init
git commit --allow-empty -m init   # sddx needs a resolvable HEAD to base tasks on
cat > spec.yaml <<'EOF'
task: health endpoint returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
EOF
sddx task create --spec spec.yaml --workspace none   # registers the task (phase PLAN)
# 1. write the failing test first — the TDD gate blocks implementation paths
#    until a failing run is observed
# 2. run: bun test tests/health.test.ts   → recorder moves the task to RED
# 3. write the implementation, re-run the tests → GREEN
sddx task phase <task-id> VERIFY
sddx verify <task-id>        # runs the oracle, writes the receipt, commits atomically
sddx board                   # renders .sddx/BOARD.md
sddx audit                   # verifies the receipt hash chain
```

Inside Claude Code the same loop is driven by `/sddx:quick` (single task) or
`/sddx:run` (parallel tasks in worktrees). Outside Claude Code, `sddx` above is
the published npm package (`npx @glapsfun/sddx ...` works with no install);
the same commands also run from a checkout as `bin/sddx-run dist/cli.mjs`.

## Documentation

| Page                                                     | What it covers                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| [Installation](docs/how-to/install-sddx.md)                     | Every install path, verification, uninstall, privacy                  |
| [Usage](docs/usage.md)                                   | The task loop, `/sddx:run` and `/sddx:quick`, worktrees, the board    |
| [Spec reference](docs/spec-reference.md)                 | Every spec field, good/bad criteria, the four oracle types            |
| [Hooks & the TDD gate](docs/reference/hooks.md)                    | The five hooks, gate classification, default globs, the escape hatch  |
| [CLI reference](docs/reference/cli.md)                             | Every `sddx` command, flag, and exit code                             |
| [Receipts & audit](docs/receipts-and-audit.md)           | Receipt schema, the hash chain, audit findings and remediation        |
| [Architecture](docs/explanation/architecture.md)                     | Codebase map, build pipeline, state model, design principles          |
| [Troubleshooting](docs/how-to/troubleshoot-common-problems.md)               | Gate blocks, stuck tasks, orphan worktrees, audit failures            |
| [Releasing](docs/RELEASING.md)                           | The release checklist                                                 |
| [Contributing](CONTRIBUTING.md)                          | Dev setup, quality gates, PR expectations                             |
| [Changelog](CHANGELOG.md)                                | Release history                                                       |
| [Security](SECURITY.md)                                  | Zero-network design and vulnerability reporting                       |

## Development

Dev setup, everyday commands, and the quality gates live in
[CONTRIBUTING.md](CONTRIBUTING.md); the release process is in
[docs/RELEASING.md](docs/RELEASING.md).
