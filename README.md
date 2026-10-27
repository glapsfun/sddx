# sddx

[![ci](https://img.shields.io/github/actions/workflow/status/glapsfun/sddx/ci.yml?branch=main&label=ci)](https://github.com/glapsfun/sddx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40glapsfun%2Fsddx?label=npm)](https://www.npmjs.com/package/@glapsfun/sddx)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![typescript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Spec-driven development with proof, for coding agents. Your agent writes the
code its usual way; sddx is the gate and the manager around it:

- **One spec per goal.** A design you agree with in conversation, then tasks,
  each with an executable oracle. Nothing starts until you approve the plan.
- **A boundary proof per task.** `sddx verify` runs the task's oracle on the
  base with only the task's tests applied, where it must fail, and on the
  finished tree, where it must pass. Tests that do not catch the change do not
  count.
- **A review bound to the proven diff.** A critic in a clean context reviews
  exactly what was proven, and only a passing review finishes the task.
- **A receipt for every task.** Hash-chained, optionally signed, and
  re-checkable by anyone with `sddx audit`.

Every guarantee is enforced by the sddx CLI and git, so it holds in any harness
and in CI. The plugin adds the workflow on top: skills that steer the agent
from idea to pull request, and hooks that raise your own permission dialog
when a plan is approved.

## Install

sddx runs on **[Bun](https://bun.sh)**, the one prerequisite:

```sh
curl -fsSL https://bun.sh/install | bash
```

Then, in Claude Code:

```
/plugin marketplace add glapsfun/sddx
/plugin install sddx@sddx
```

On Claude Code 2.1.275 or later, `/plugin install sddx --marketplace glapsfun/sddx`
does both in one step. Nothing is written into your repository until you plan
your first goal. Details, pre-release builds and removal:
[Install sddx](docs/how-to/install-sddx.md). To have teammates prompted to
install it when they open the repository, see
[Share sddx with a team](docs/how-to/share-sddx-with-a-team.md).

For CI and scripts, the same CLI is on npm. Re-check a repository's receipt
chain in CI with:

```sh
npx @glapsfun/sddx audit --ci
```

Coming from sddx 5? See [Migrate to sddx 6](docs/how-to/migrate-to-v6.md).

## What a session looks like

In a repository that uses sddx, ask for a change, or start one with
`/sddx:brainstorm`:

1. **Brainstorm.** The agent asks about purpose and constraints, one question
   at a time, and writes the design into `.sddx/specs/<date>-<slug>.md`.
2. **Plan.** It splits the design into tasks with oracles and scopes. You
   review the plan, and approving it raises your permission dialog.
3. **Execute.** Each task gets its own git worktree and a worker subagent,
   in parallel where scopes allow. Each ends at `sddx verify`.
4. **Review.** A critic subagent reviews the proven diff. A pass commits the
   task with its receipt and merges it into the goal's run branch.
5. **Finish.** `sddx pr create` opens a pull request from the run branch. You
   merge it.

[Getting started](docs/tutorials/01-getting-started.md) walks through one goal
end to end.

### Privacy

sddx makes no network calls of its own. Its state is files under `.sddx/` and
git. The only commands that reach the network are ones you ask for: installing
the plugin, and `sddx pr create`, which pushes the run branch and opens a pull
request through `gh` or `glab`. Nothing on a hot path (session start, hooks,
gates) ever reaches the network.

## Documentation

**New to sddx?**

- [Getting started](docs/tutorials/01-getting-started.md): your first goal, from install to merged
- [Your first parallel run](docs/tutorials/02-your-first-parallel-run.md): two tasks, two worktrees, one run branch

**How-to guides**

- [Install sddx](docs/how-to/install-sddx.md)
- [Share sddx with a team](docs/how-to/share-sddx-with-a-team.md)
- [Model DAG dependencies](docs/how-to/model-dag-dependencies.md)
- [Configure retry and skip/block](docs/how-to/configure-retry-and-skip.md)
- [Choose an oracle type](docs/how-to/choose-an-oracle-type.md)
- [Verify and audit receipts](docs/how-to/verify-and-audit-receipts.md)
- [Ship a goal as a PR](docs/how-to/ship-a-goal-as-a-pr.md)
- [Tune config](docs/how-to/tune-config.md)
- [Troubleshooting](docs/how-to/troubleshoot-common-problems.md)
- [Migrate to sddx 6](docs/how-to/migrate-to-v6.md)

**Reference**

- [Spec reference](docs/reference/spec-reference.md)
- [CLI reference](docs/reference/cli.md)
- [Verification](docs/reference/verification.md)
- [Hooks and the plugin](docs/reference/hooks.md)
- [Receipts schema](docs/reference/receipts-schema.md)
- [Config reference](docs/reference/config.md)

**Understand the design**

- [Why sddx](docs/explanation/why-sddx.md)
- [Design principles](docs/explanation/design-principles.md)
- [How it compares](docs/explanation/how-it-compares.md)
- [Architecture](docs/explanation/architecture.md)
- [Interaction modes: human-in-the-loop and unattended](docs/explanation/interaction-modes.md)

**Runnable examples**

- [examples/](examples/README.md): one scaffold per feature, driving the CLI by hand, replayed in CI

**Project**

- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## Development

Dev setup, everyday commands and the quality gates live in
[CONTRIBUTING.md](CONTRIBUTING.md); the release process is in
[docs/RELEASING.md](docs/RELEASING.md).
