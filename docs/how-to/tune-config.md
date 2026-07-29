# Tune config

Every `userConfig` key, its env var, and its default are in
[config.md](../reference/config.md). This guide is the mechanics: where to
put an override, what wins when several sources disagree, and what
`sddx config validate` actually checks. A full runnable walkthrough is
[examples/09-config-tuning](../../examples/09-config-tuning/).

## Where overrides live

Inside Claude Code, enabling the plugin prompts for these settings and
materializes them into `.sddx/config.json` — there's nothing to hand-edit.
Outside Claude Code, write `.sddx/config.json` yourself — and it should be *you*:
the file carries `interaction_mode`, so an agent's `Edit`/`Write` to it is blocked
outright, and a Bash command naming it is refused unless it is a plain read.
That Bash check is textual, so it is a deterrent rather than a proof — an
expansion that never spells the path out is not caught. Reading the file back is
always fine (`sddx config show` reports the effective values).

```json
{
  "workspace_mode": "branch",
  "stuck_threshold": 5
}
```

## Precedence

Environment variable → `.sddx/config.json` → built-in default, highest
first. Only some keys have an environment variable at all (see the table in
[config.md](../reference/config.md)) — setting `SDDX_STUCK_THRESHOLD=7`
outranks a config-file `stuck_threshold`, but there's no equivalent variable
for `workspace_mode`.

## Seeing what won

`sddx config show` prints every key fully resolved. Set `verbose: true` and
it also prints, per key, which source actually won (`env`, `config`, or
`default`) — the one place `verbose` changes `terminal` output; `--output
json`/`--output markdown` already carry the fully-resolved values regardless
of `verbose`.

## Renaming `execution_mode`

The key that decides whether a human is consulted is now `interaction_mode`.
The old name is still read, so nothing breaks — but `sddx config validate`
reports it, naming the replacement:

```diff
 {
-  "execution_mode": "auto"
+  "interaction_mode": "auto"
 }
```

Set both and `interaction_mode` wins, with a warning saying so. See
[config.md](../reference/config.md#migrating-execution_mode--interaction_mode).

## Validating without guessing

`sddx config validate` checks `.sddx/config.json` against the schema and
reports unrecognized keys and out-of-domain values (not just wrong
`typeof` — `stuck_threshold: -2` and a typo'd `workspace_mode` are both
caught) as **warnings** — exit 0, since a structurally-parseable file with a
bad key shouldn't block anything. The one case that fails outright (exit 1)
is unparseable JSON, or JSON that isn't an object — that's a broken file, not
a schema disagreement. A missing `.sddx/config.json` is not an error either
way; built-in defaults apply.
