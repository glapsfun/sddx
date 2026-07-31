# Installation

sddx is a single npm package: `@glapsfun/sddx`. Installing it gives you the
`sddx` command; running `sddx init` in a repository sets that repository up,
including — if you want it — Claude Code integration installed *project-locally*
under `.claude/`.

There is no plugin to install. See
[migrate-from-plugin.md](migrate-from-plugin.md) if you used the old
marketplace distribution.

## Prerequisites

- **[Bun](https://bun.sh) on your `PATH`.** It is the only supported runtime,
  and none of the installers below will install it for you:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

  Invoking `sddx` without Bun exits non-zero and tells you this. There is no
  Node.js fallback.
- **git.** `sddx init` refuses to run outside a repository, and the worktree
  isolation model is git's.
- **No runtime dependencies.** `dist/cli.mjs` is a dependency-free single-file
  bundle; installing sddx pulls nothing else in.

## Install

```sh
npm install -g @glapsfun/sddx     # or: bun add -g @glapsfun/sddx
```

Or run it without installing:

```sh
npx @glapsfun/sddx init
bunx @glapsfun/sddx init
```

The package name is scoped (`@glapsfun/sddx`) because the bare name `sddx` is
blocked by npm's package-name-similarity policy; the installed command is plain
`sddx` — the package's `bin` entry, not its registry name.

## Set up a repository

```sh
cd your-repo
sddx init
```

On a terminal this asks four short questions and then shows you every file it
would create or modify, every package-manager command it would run, and every
configuration value it would write. Nothing is touched until you approve, and
declining leaves the repository byte-identical.

### Runtime scope

The one choice worth thinking about:

| Scope | What generated content runs | When to pick it |
| --- | --- | --- |
| `global` | `sddx` | Simplest. You installed sddx globally and that is the version you want. |
| `project` | `npm exec --offline --no -- sddx` (or `bunx --no-install sddx`) | Everyone on the team runs the version in the lockfile, not whatever they happen to have installed. |

Project-pinned scope adds `@glapsfun/sddx` to your dev dependencies — the one
package-manager command `init` runs, and only after you confirm it.

Neither scope copies an sddx runtime into `.sddx/`. Package managers own
package bytes; sddx owns configuration and adapter setup.

### Adapters

`--adapter claude` installs Claude Code integration into `.claude/`:

- the sddx skills (`sddx-run`, `sddx-plan`, `sddx-verify`, `sddx-board`,
  `sddx-audit`, `sddx-pr`), `sddx-` prefixed so they cannot collide with your own;
- the five role-restricted agent definitions;
- hook registrations in `.claude/settings.json` for the TDD gate, the Bash
  gate, the approval gate, the test recorder, the stop gate, and the
  SessionStart bootstrap.

It writes nothing outside the repository and never touches your global Claude
configuration.

Hooks go in the **committed, team-shared** `settings.json` rather than the
personal `settings.local.json` on purpose: the TDD gate is a team contract, and
a gate only one person has is not one. If your repository gitignores `.claude/`,
`sddx doctor` will point that out.

## Non-interactive install

For CI and scripts, the same choices are flags. Without a TTY, `init` never
prompts — it either has enough flags to be deterministic, or it fails and names
the ones it needs:

```sh
sddx init --yes --runtime global --adapter claude
sddx init --yes --runtime project --package-manager npm --adapter claude
sddx init --dry-run --runtime global --output json     # preview, machine-readable
```

## Verifying the install

```sh
sddx doctor
```

It reports Bun, the git repository, the running version, project config, the
runtime scope and how it resolves, adapter health (including whether any
generated file has drifted), and any leftover plugin state. Every failure comes
with the exact command that fixes it. Exit code is non-zero if anything failed.

## Configuration

`sddx init` writes `.sddx/config.json` — machine-readable project policy, under
version control, and the only configuration source sddx reads:

| Key | Default | Meaning |
| --- | --- | --- |
| `schema_version` | `1.0` | The config schema this file was written against |
| `interaction_mode` | `human` | Whether a human approves the plan before anything is created |
| `runtime_scope` | `global` | How generated content invokes sddx |
| `package_manager` | `npm` | Which package manager runs the local binary under project scope |
| `adapters` | `[]` | Which project adapters `init`/`sync` maintain |
| `test_globs` | *(empty)* | Extra globs classified as test files by the TDD gate |
| `exempt_globs` | *(empty)* | Extra globs exempt from the RED-phase write block |
| `max_iterations_default` | `5` | Default stop rule: max loop iterations per task |
| `board_enabled` | `true` | Regenerate `.sddx/BOARD.md` automatically |
| `oracle_runs_default` | `1` | How many times verify executes the oracle |
| `red_bash_allow` | *(empty)* | Extra commands the RED-phase Bash gate allows |
| `stuck_threshold` | `3` | Identical failures before a task is flagged stuck |
| `pr_host` | *(auto)* | `gh` \| `glab`; empty auto-detects from the origin remote |
| `agent_model` | *(empty)* | Advisory `role=model` pairs read when dispatching subagents |
| `verbose` | `false` | `sddx config show` also prints which source resolved each key |
| `auto_max_tasks` | `6` | In auto mode, a larger plan is refused rather than run |

`sddx config show` and `sddx config validate` read and check these; neither
writes. See [../reference/cli.md](../reference/cli.md#sddx-config-show).

## Keeping it up to date

```sh
npm install -g @glapsfun/sddx@latest           # global scope
npm install --save-dev @glapsfun/sddx@latest   # project-pinned scope
sddx sync --adapter claude                     # regenerate the adapter files
```

`sync` previews every change and writes only files sddx can prove it owns. If
you edited a generated file by hand, it refuses and tells you so rather than
overwriting your work.

## Uninstall

Remove the adapter from a repository:

```sh
sddx uninstall --adapter claude
```

This removes only the files recorded in the adapter's ownership manifest, and
strips only sddx's own entries from `.claude/settings.json` — your other Claude
configuration is preserved verbatim. A generated file you have since modified
is reported and left in place rather than deleted.

Your `.sddx/` directory — specs, tasks, receipts, board — stays, by design: it
is version-controlled project state, not integration state.

To remove the tool itself:

```sh
npm uninstall -g @glapsfun/sddx
```

## Privacy

The sddx runtime makes **zero network calls**. Everything is local files
(`.sddx/` under version control) and local git. No telemetry, no phoning home,
no remote fetches — the bundle ships dependency-free and never imports a
network API.

The one exception is explicit and never silent: installing the package itself,
and the single dependency install `sddx init` performs *after you confirm it*
when you pick the project-pinned runtime scope. No hot path — session start,
hooks, gates — ever reaches the network.

See [SECURITY.md](../../SECURITY.md) for the security policy.
