# Installation

sddx is a Claude Code plugin. This page covers every way to install it, how to
verify the install, and how to remove it.

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
