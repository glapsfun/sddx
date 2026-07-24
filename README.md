# sddx

[![ci](https://img.shields.io/github/actions/workflow/status/glapsfun/sddx/ci.yml?branch=main&label=ci)](https://github.com/glapsfun/sddx/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fglapsfun%2Fsddx%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=version)](https://github.com/glapsfun/sddx)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![typescript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Loop-based Spec-Driven Development for Claude Code: dense specs with mandatory
oracles, hook-enforced TDD, parallel git worktrees, and hash-chained receipts.
Process over intelligence, proof over promises.

Hooks hard-block implementation writes before a failing test exists, every
goal requires an executable oracle, and every finished task leaves a
hash-chained receipt in the repo. See
[why sddx exists](docs/explanation/why-sddx.md) for the full problem/mechanism
breakdown.

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

## Quickstart

```sh
mkdir demo && cd demo && git init
git commit --allow-empty -m init
```

Then follow [Getting started](docs/tutorials/01-getting-started.md) — the
same loop `/sddx:quick`/`--solo` drive inside Claude Code, one command at a
time, ending in a verified receipt. Every command there (and in every guide
below) is also a copy-paste-able scaffold under
[examples/](examples/README.md).

## Documentation

**New to sddx?**

- [Getting started](docs/tutorials/01-getting-started.md) — your first verified task, by hand from the CLI
- [Your first parallel run](docs/tutorials/02-your-first-parallel-run.md) — two tasks, two worktrees

**How-to guides**

- [Install sddx](docs/how-to/install-sddx.md)
- [Model DAG dependencies](docs/how-to/model-dag-dependencies.md)
- [Configure retry and skip/block](docs/how-to/configure-retry-and-skip.md)
- [Use branch mode](docs/how-to/use-branch-mode.md)
- [Choose an oracle type](docs/how-to/choose-an-oracle-type.md)
- [Verify and audit receipts](docs/how-to/verify-and-audit-receipts.md)
- [Ship a goal as a PR](docs/how-to/ship-a-goal-as-a-pr.md)
- [Tune config](docs/how-to/tune-config.md)
- [Troubleshooting](docs/how-to/troubleshoot-common-problems.md)

**Reference**

- [Spec reference](docs/reference/spec-reference.md)
- [CLI reference](docs/reference/cli.md)
- [Hooks & the TDD gate](docs/reference/hooks.md)
- [Receipts schema](docs/reference/receipts-schema.md)
- [Config reference](docs/reference/config.md)

**Understand the design**

- [Why sddx](docs/explanation/why-sddx.md)
- [Design principles](docs/explanation/design-principles.md)
- [How it compares](docs/explanation/how-it-compares.md)
- [Architecture](docs/explanation/architecture.md)

**Runnable examples**

- [examples/](examples/README.md) — one scaffold per feature above, replayed in CI

**Project**

- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## Development

Dev setup, everyday commands, and the quality gates live in
[CONTRIBUTING.md](CONTRIBUTING.md); the release process is in
[docs/RELEASING.md](docs/RELEASING.md).
