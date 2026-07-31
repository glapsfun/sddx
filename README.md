# sddx

[![ci](https://img.shields.io/github/actions/workflow/status/glapsfun/sddx/ci.yml?branch=main&label=ci)](https://github.com/glapsfun/sddx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40glapsfun%2Fsddx?label=npm)](https://www.npmjs.com/package/@glapsfun/sddx)
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

**[Bun](https://bun.sh) is required** — it is the only supported runtime, and
no installer installs it for you:

```sh
curl -fsSL https://bun.sh/install | bash
```

Then install sddx from npm and set up a repository:

```sh
npm install -g @glapsfun/sddx     # or: bun add -g @glapsfun/sddx
cd your-repo
sddx init
```

No install needed to try it: `npx @glapsfun/sddx init` or
`bunx @glapsfun/sddx init`. The package is scoped as `@glapsfun/sddx`; the
command it installs is plain `sddx`.

`sddx init` asks four short questions, previews every file it would touch, and
does nothing until you approve:

- **Runtime scope** — `global` (an `sddx` on your `PATH`) or `project` (a
  lockfile-backed dev dependency, so the whole team runs the same version).
- **Adapters** — `claude` installs Claude Code skills, agents, and the
  TDD-gate hooks into `.claude/`, project-locally. No plugin, no global config.
- **Interaction mode** — whether a human approves the plan before anything runs.

For CI and scripts, the same choices are flags:

```sh
sddx init --yes --runtime global --adapter claude
```

Check everything landed with `sddx doctor`. Migrating from the old marketplace
plugin? See [docs/how-to/migrate-from-plugin.md](docs/how-to/migrate-from-plugin.md).

### Privacy

The sddx runtime makes **zero network calls**. All state is local files
(`.sddx/` under version control) and local git.

There is exactly one exception, and it is never silent: installing the package
itself, and — if you choose the project-pinned runtime scope — the single
dependency install `sddx init` runs *after you confirm it*. Nothing on a hot
path (session start, hooks, gates) ever reaches the network.

## Quickstart

```sh
mkdir demo && cd demo && git init
git commit --allow-empty -m init
```

Then follow [Getting started](docs/tutorials/01-getting-started.md) — a
**one-node run**, one command at a time, ending in a verified receipt. A single
task is not a special mode: it is a run with one node, and it gets the same
goal, run branch, worktree, oracle, and receipt as any other. That is the loop
`/sddx:run` drives for you inside Claude Code. Every command there (and in
every guide below) is also a copy-paste-able scaffold under
[examples/](examples/README.md).

## Documentation

**New to sddx?**

- [Getting started](docs/tutorials/01-getting-started.md) — your first verified task, by hand from the CLI
- [Your first parallel run](docs/tutorials/02-your-first-parallel-run.md) — two tasks, two worktrees

**How-to guides**

- [Install sddx](docs/how-to/install-sddx.md)
- [Model DAG dependencies](docs/how-to/model-dag-dependencies.md)
- [Configure retry and skip/block](docs/how-to/configure-retry-and-skip.md)
- [Choose an oracle type](docs/how-to/choose-an-oracle-type.md)
- [Verify and audit receipts](docs/how-to/verify-and-audit-receipts.md)
- [Ship a goal as a PR](docs/how-to/ship-a-goal-as-a-pr.md)
- [Tune config](docs/how-to/tune-config.md)
- [Troubleshooting](docs/how-to/troubleshoot-common-problems.md)
- [Migrate to sddx 4.0](docs/how-to/migrate-to-v4.md) — old-to-new command mappings

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
- [Interaction modes: human-in-the-loop and unattended](docs/explanation/interaction-modes.md)

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
