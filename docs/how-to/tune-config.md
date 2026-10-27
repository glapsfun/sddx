# Tune config

Every key, its environment variable and its default are in
[the config reference](../reference/config.md). This guide is the mechanics:
where an override goes, what wins when sources disagree, and what
`sddx config validate` checks. A runnable walkthrough is
[examples/09-config-tuning](../../examples/09-config-tuning/).

## Where overrides live

sddx needs no configuration: defaults apply when `.sddx/config.json` is absent,
and `sddx plan start` writes it the first time it creates state. To change a
setting, edit that file yourself and commit it, so the whole team gets it.

It should be you who edits it. The file carries `interaction_mode` and
`profile`, which decide whether a plan needs your approval and how strictly
edits are gated, so the approval gate refuses an agent's file-tool write to it
and any shell command that writes it. That shell check is textual, a deterrent
rather than a proof. Reading the file is always fine.

```json
{
  "oracle_runs_default": 3,
  "stuck_threshold": 5
}
```

## Precedence

Environment variable, then `.sddx/config.json`, then the built-in default,
highest first. Only some keys have an environment variable: setting
`SDDX_STUCK_THRESHOLD=7` outranks a config-file `stuck_threshold`.
`interaction_mode` and `profile` deliberately have none: a variable would be a
second way for an agent to switch off a gate it is subject to.

## Seeing what won

```sh
sddx config show
```

It prints every key fully resolved. With `"verbose": true` it also prints, per
key, which source won: `env`, `config` or `default`.

## Validating

```sh
sddx config validate
```

It reports unrecognized keys and out-of-range values as warnings and exits 0,
since a parseable file with a bad key should not block anything. A value such
as `stuck_threshold: -2` or a misspelled `interaction_mode` is caught, not just
a wrong type. Keys sddx 6 removed (`runtime_scope`, `package_manager`,
`adapters`) are reported as removed rather than as typos. Unparseable JSON, or
JSON that is not an object, fails with exit 1.

A config whose `schema_version` is 1.x was written by sddx 5, and sddx 6
commands refuse it until you run `sddx migrate`
([Migrate to sddx 6](migrate-to-v6.md)). The old key `execution_mode` is still
read when `interaction_mode` is absent.
