# Install sddx

sddx ships as a Claude Code plugin, distributed from its own GitHub repository.
The plugin brings the workflow skills, two subagents, the hooks, and the sddx
CLI itself. The same CLI is on npm for CI and scripts.

## Prerequisites

- **[Bun](https://bun.sh).** The CLI and the hooks run on it, and nothing
  installs it for you:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

  Without Bun, the CLI exits with this install command, and session start says
  the same.
- **git.** Every task gets its own git worktree.
- **Claude Code** with plugin support.

## Install the plugin

In Claude Code:

```
/plugin marketplace add glapsfun/sddx
/plugin install sddx@sddx
```

On Claude Code 2.1.275 or later, `/plugin install sddx --marketplace glapsfun/sddx`
does both in one step. From a terminal, the same is:

```
claude plugin marketplace add glapsfun/sddx
claude plugin install sddx@sddx
```

Installed for your user, the plugin loads in every repository, but it only
steers work in repositories with a `.sddx/` directory. Everywhere else session
start adds one line saying sddx is available. To make it part of a project for
everyone who works on it, see [Share sddx with a team](share-sddx-with-a-team.md).

## What the plugin adds

- Skills: `/sddx:brainstorm`, `/sddx:plan`, `/sddx:execute`, `/sddx:review`,
  `/sddx:finish`, `/sddx:debug`, and the `using-sddx` router that session start
  loads in repositories that use sddx.
- Subagents: `sddx:worker` implements one task in its worktree; `sddx:critic`
  reviews a proven diff and cannot edit files.
- Hooks: the plan approval dialog, the stop gate, and the strict-profile gates
  ([Hooks and the plugin](../reference/hooks.md)).
- The `sddx` command, on the agent's `PATH`.

Nothing is written into a repository until you plan the first goal there, and
sddx never writes into `.claude/`.

## Check the install

Start a session in any repository. Session start should report sddx as
available, or as active in a repository that uses it. Ask the agent to run:

```sh
sddx doctor
```

It reports Bun, git, the version, the project config, and any sddx 5 leftovers,
each failure with the command that fixes it.

## Pre-release builds

To try the next major version before it is released, add the marketplace at its
integration branch instead:

```
/plugin marketplace add glapsfun/sddx#v6
```

## Updating

The plugin's version changes only when sddx is released, so an update always
brings a released build. Update it from the `/plugin` menu.

## The CLI in CI and scripts

The CLI the plugin bundles is also the npm package `@glapsfun/sddx`. In CI, run
it with `npx` or `bunx`, with Bun installed:

```sh
npx @glapsfun/sddx audit --ci
```

To pin the version CI runs, add it as a dev dependency of the project. Every
guarantee sddx makes is enforced by this CLI, so CI can re-check receipts
without Claude Code.

## Configuration

There is nothing to configure up front. `sddx plan start` writes
`.sddx/config.json` with safe defaults the first time it creates state, and the
file is yours to commit and edit. `sddx config show` prints the effective
values; [the config reference](../reference/config.md) lists every key.

## Uninstall

Remove the plugin from the `/plugin` menu. `.sddx/` stays in your repositories:
specs, receipts and goal records are history, and `sddx audit` still verifies
them from the npm package.

## Privacy

sddx makes no network calls of its own. The only commands that reach the
network are ones you ask for: installing the plugin, and `sddx pr create`,
which pushes the run branch and opens a pull request through `gh` or `glab`.
