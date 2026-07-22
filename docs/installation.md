# Installation

sddx is a Claude Code plugin *and* a standalone npm package — the same CLI,
reachable two independent ways. This page covers every way to install it, how
to verify the install, and how to remove it.

## Prerequisites

- **Claude Code** with plugin support (the `claude plugin` command group).
- **No runtime install.** The bundles in `dist/` are dependency-free single-file
  `.mjs` scripts. The launcher (`bin/sddx-run`) prefers [Bun](https://bun.sh)
  and falls back to Node.js ≥ 18 — one of the two must be on `PATH`, which is
  already true on any machine running Claude Code.
- **Bun is only needed for development** of sddx itself (version pinned in
  `.bun-version`). See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Marketplace install

The recommended path:

```sh
claude plugin marketplace add glapsfun/sddx
claude plugin install sddx@sddx
```

When you enable the plugin, Claude Code prompts for its settings — there are no
hand-edited config files and no environment variables:

| Setting                  | Default | Meaning                                                              |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `workspace_mode`         | `auto`  | Task workspace strategy: `worktree` \| `branch` \| `auto`            |
| `test_globs`             | *(empty)* | Space-separated extra globs classified as test files by the TDD gate |
| `exempt_globs`           | *(empty)* | Space-separated extra globs exempt from the RED-phase write block    |
| `max_iterations_default` | `5`     | Default stop rule: max loop iterations per task                      |
| `board_enabled`          | `true`  | Regenerate `.sddx/BOARD.md` automatically                            |
| `pr_host`                | *(auto-detected)* | PR-host CLI for `sddx pr create`: `gh` \| `glab`. Unset detects from the `origin` remote (`github.com` → `gh`, `gitlab.com` → `glab`); refuses if neither matches |
| `agent_model`             | *(empty)* | Comma-separated `role=model` pairs (`orchestrator`, `planner`, `tddExecutor`, `verifier`) — **advisory**: read by `/sddx:run`/`/sddx:quick` via `sddx config show --json` when dispatching a subagent, not enforced by any hook |
| `prefer_solo`             | `false` | **Advisory** hint `/sddx:run` reads to steer a single trivial task toward `--solo`/`/sddx:quick` instead of the full worktree flow |
| `verbose`                 | `false` | When true, `sddx config show` also prints which source (env var, `.sddx/config.json`, or built-in default) resolved each key |

See [cli.md](cli.md#sddx-config-show) for `sddx config show`/`sddx config validate`, which read and check this table's values.

## Standalone CLI (npm / npx / bun)

Independent of Claude Code — for CI pipelines, other agent harnesses, or
running the loop by hand:

```sh
npx @glapsfun/sddx board            # no install, always latest published version
npm install -g @glapsfun/sddx       # or: bun add -g @glapsfun/sddx / bunx @glapsfun/sddx
```

The npm package is scoped (`@glapsfun/sddx`) since the bare name `sddx` is
blocked by npm's package-name-similarity policy (too close to existing
packages like `sax`/`shx`/`sade`); the installed command is still plain
`sddx` — the package's `bin` entry, not its registry name.

This installs the same `dist/cli.mjs` the plugin uses internally — `sddx task
create`, `sddx verify`, `sddx board`, `sddx audit`, etc. all work identically.
It does **not** install the Claude Code plugin (skills, agents, hooks) — there
is no TDD-gate hook enforcement without the plugin; see
[skills-only mode](#skills-only-mode) below for the same caveat in the
opposite direction. Use the marketplace install above if you want the
conversational `/sddx:run` / `/sddx:quick` skills and the hard-blocking hooks.

## Local development

To run Claude Code with the plugin loaded straight from a checkout:

```sh
claude --plugin-dir /path/to/sddx
```

## Skills-only mode

Copy the `skills/` subdirectories into your project's `.claude/skills/`. The
skills auto-load, but **hook enforcement — the TDD gate, the test recorder, the
stop gate — only ships with the full plugin.** Skills-only mode gives you the
workflows without the guarantees; see
[troubleshooting](troubleshooting.md#hooks-arent-firing) if you expected the
gate and don't have it.

## Verifying the install

Validate the plugin package:

```sh
claude plugin validate --strict /path/to/sddx
```

Run this on a clean clone — a working checkout with local, gitignored files
(e.g. a personal `CLAUDE.md`) fails `--strict` even though the published
package is fine.

Confirm the hooks fire: start a Claude Code session inside any git repository
and check that `.sddx/BOARD.md` appears or is refreshed — that is the
`SessionStart` bootstrap doing its orphan-worktree sweep and board refresh.

## Uninstall

```sh
claude plugin uninstall sddx
```

Uninstalling removes the plugin only. Your `.sddx/` directory — tasks,
receipts, board — stays in each repository, by design: it is version-controlled
project state, not plugin state. Delete it like any other tracked directory if
you no longer want it.

## Privacy

sddx makes **zero network calls**. Everything is local files (`.sddx/` under
version control) and local git. No telemetry, no phoning home, no remote
fetches — the bundles ship dependency-free and never import a network API. See
[SECURITY.md](../SECURITY.md) for the security policy.
