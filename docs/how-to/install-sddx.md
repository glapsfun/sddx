# Install sddx

sddx ships as a plugin for Claude Code and for Codex, distributed from its own
GitHub repository. The plugin brings the workflow skills, the hooks, and the
sddx CLI itself, plus two subagents in Claude Code. The same CLI is on npm for
CI and scripts.

## Prerequisites

- **[Bun](https://bun.sh).** The CLI and the hooks run on it, and nothing
  installs it for you:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

  Without Bun, the CLI exits with this install command, and session start says
  the same.
- **git.** Every task gets its own git worktree.
- **Claude Code** with plugin support, or **Codex** CLI 0.164 or later.

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

## Install in Codex

From a terminal:

```
codex plugin marketplace add glapsfun/sddx
codex plugin add sddx@sddx
```

Codex reads the same marketplace and loads the plugin's Codex manifest: the
same skills and CLI, with hooks made for Codex. Then start Codex, open
`/hooks`, and trust the sddx hooks. Codex runs a plugin's hooks only after you
trust them, and asks again after every update of the plugin. Until then there
is no session context and no approval hook, though the CLI itself still
refuses a plan approval that the agent runs.

How sddx in Codex differs from Claude Code:

- Mention a skill as `$sddx:brainstorm`, `$sddx:plan` and so on.
- Codex plugins cannot ship subagents, so the agent starts the worker and the
  critic from the plugin's role files.
- `sddx` is not on the agent's `PATH`. Session start gives its full path.
- Approving a plan is yours to type: the agent asks you to run
  `!<full path>/bin/sddx plan approve <spec>`. Codex cannot raise a permission
  dialog from a hook, so the gate refuses the agent instead.
- Codex's sandbox keeps `.git` read-only, so the agent asks to run the sddx
  commands that commit or create worktrees outside it. Allow the sddx command
  once to stop the repeated prompts.
- The strict profile's per-edit gates do not run in Codex.

## What the plugin adds

- Skills: `/sddx:brainstorm`, `/sddx:plan`, `/sddx:execute`, `/sddx:review`,
  `/sddx:finish`, `/sddx:debug`, and the `using-sddx` router that session start
  loads in repositories that use sddx.
- Subagents, in Claude Code: `sddx:worker` implements one task in its worktree;
  `sddx:critic` reviews a proven diff and cannot edit files.
- Hooks: the plan approval dialog, the stop gate, and the strict-profile gates
  ([Hooks and the plugin](../reference/hooks.md)).
- The `sddx` command, on the agent's `PATH` in Claude Code, and by full path in
  Codex.

Nothing is written into a repository until you plan the first goal there, and
sddx never writes into `.claude/`, `.codex/` or `.agents/`.

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

In Codex:

```
codex plugin marketplace add glapsfun/sddx --ref v6
```

## Updating

The plugin's version changes only when sddx is released, so an update always
brings a released build. Update it from the `/plugin` menu. In Codex, run
`codex plugin marketplace upgrade sddx`, then trust the hooks again in `/hooks`.

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

Remove the plugin from the `/plugin` menu, or in Codex with
`codex plugin remove sddx@sddx`. `.sddx/` stays in your repositories:
specs, receipts and goal records are history, and `sddx audit` still verifies
them from the npm package.

## Privacy

sddx makes no network calls of its own. The only commands that reach the
network are ones you ask for: installing the plugin, and `sddx pr create`,
which pushes the run branch and opens a pull request through `gh` or `glab`.
