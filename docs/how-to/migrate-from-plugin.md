# Migrating from the Claude Code plugin

sddx used to ship as a Claude Code marketplace plugin. It no longer does. The
npm package `@glapsfun/sddx` is the only supported distribution, and Claude Code
integration is now installed *per repository* by `sddx init --adapter claude`.

Nothing about the loop changes: the same skills, the same role-restricted
agents, the same hook-enforced TDD gate, the same receipts. What changes is
where they come from and who owns them.

**Your project state is not affected.** `.sddx/` — specs, tasks, goals,
receipts, the board — is version-controlled project state and migrates
untouched. Your receipt chain keeps validating across the boundary.

## Before you start

Install Bun if you do not have it. This is the one genuinely breaking
requirement: the Node.js fallback is gone, and no installer installs Bun for
you.

```sh
curl -fsSL https://bun.sh/install | bash
bun --version
```

## The four steps, in order

The order matters. Do not remove the plugin first — verify the replacement
works while the old path is still there to fall back on.

### 1. Install the package

```sh
npm install -g @glapsfun/sddx     # or: bun add -g @glapsfun/sddx
sddx --version
```

### 2. Initialize each repository

```sh
cd your-repo
sddx init --adapter claude
```

`init` previews every file it would write before touching anything. It installs
into `.claude/` — skills as `sddx-<name>`, agents as `sddx-<role>.md`, and hook
registrations merged into `.claude/settings.json` alongside whatever you already
have there.

If a destination already holds a file sddx did not generate, `init` refuses and
names it rather than overwriting. Move yours aside and re-run.

### 3. Verify

```sh
sddx doctor
```

Everything should pass. While the plugin is still installed you will also see a
`legacy-plugin` warning about duplicate hook registrations — that is expected at
this point, and safe: both sets of hooks fire, and they agree, because they run
the same gate logic.

Then actually exercise it. Start a Claude Code session in the repository and run
a one-node `/sddx:run` through to a verified receipt. That is the real check.

### 4. Remove the plugin — last

```sh
claude plugin uninstall sddx
claude plugin marketplace remove sddx
```

**sddx will not do this for you.** A Claude plugin is global harness
configuration, which the new design deliberately puts out of sddx's reach — the
same property that lets `sddx uninstall` promise it only removes what it owns.

Re-run `sddx doctor`; the `legacy-plugin` warning should be gone.

## What changed, concretely

| Before | After |
| --- | --- |
| `claude plugin install sddx@sddx` | `npm install -g @glapsfun/sddx` then `sddx init` |
| Settings prompted by Claude at enable time | `.sddx/config.json`, written by `sddx init`, committed and reviewable |
| Skills/agents/hooks from the plugin root | Generated into `.claude/`, owned and updated by `sddx sync` |
| Hooks invoked `${CLAUDE_PLUGIN_ROOT}/bin/sddx-run …` | Hooks invoke `sddx hook <event>` (or the project-pinned equivalent) |
| Bun preferred, Node ≥ 18 fallback | **Bun required**, no fallback |
| Version read from `.claude-plugin/plugin.json` | Version read from `package.json` |
| Updates via `claude plugin update` | Updates via your package manager, then `sddx sync --adapter claude` |

Receipts keep their `plugin_version` field name. Renaming it would change the
bytes every historical receipt is hashed over and break `sddx audit` at the
version boundary; the value now comes from `package.json`. See
[../reference/receipts-schema.md](../reference/receipts-schema.md).

## Configuration you had set

Plugin settings you configured through Claude Code do not carry over
automatically — they lived in Claude's own state, not in your repository. Every
key kept its name and default, so copy them into `.sddx/config.json`:

```jsonc
{
  "schema_version": "1.0",
  "interaction_mode": "human",
  "runtime_scope": "global",
  "package_manager": "npm",
  "adapters": ["claude"],
  // …plus any of the tuning keys you had customized
  "max_iterations_default": 5,
  "stuck_threshold": 3
}
```

`sddx config validate` type-checks the result and names anything it does not
recognize. The full table is in
[install-sddx.md](install-sddx.md#configuration).

## If something goes wrong

- **`sddx: bun is required`** — install Bun. There is no fallback runtime.
- **`init` refuses on a collision** — a file already exists at a generated path
  that sddx did not write. Move yours aside, or re-run with `--force` to
  overwrite (a `.bak` copy is kept).
- **Hooks are not firing** — check `.claude/settings.json` actually contains the
  sddx entries, and that `sddx doctor` reports the adapter up to date. If your
  repository gitignores `.claude/`, teammates will not get the gate; `doctor`
  warns about exactly this.
- **You want to go back** — pin the previous major of the package and reinstall
  the plugin. Your `.sddx/` state is unchanged either way.
