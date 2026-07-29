# Example: tuning config

Defaults, an override in `.sddx/config.json`, an environment variable
winning over that override, `config validate`'s warnings, and the one case
it fails outright.

## Setup

```sh skip
bash examples/09-config-tuning/setup.sh
```

`cd` into the printed directory before running anything below.

## Defaults

```sh
./sddx config show | grep -q "^stuck_threshold: 3$"
./sddx config show | grep -q "^oracle_runs_default: 1$"
```

## Override via `.sddx/config.json`

```sh
mkdir -p .sddx
cat > .sddx/config.json <<'EOF'
{
  "oracle_runs_default": 3,
  "stuck_threshold": 5,
  "verbose": true
}
EOF
./sddx config show | grep -q "^oracle_runs_default: 3$"
./sddx config show | grep -q "^stuck_threshold: 5$"
```

`verbose: true` adds a resolution-detail block naming which source won for
each key:

```sh
./sddx config show | grep -q "resolution detail"
./sddx config show | grep -q "stuck_threshold: source=config"
```

## An environment variable outranks the config file

```sh
SDDX_STUCK_THRESHOLD=7 ./sddx config show | grep -q "^stuck_threshold: 7$"
```

## `config validate`'s warnings (never a hard failure for a valid file)

```sh
cat > .sddx/config.json <<'EOF'
{
  "stuck_threshold": -2,
  "totally_unknown_key": true
}
EOF
```

```sh
./sddx config validate 2>&1 | grep -q 'warning: "stuck_threshold" must be a positive integer'
./sddx config validate 2>&1 | grep -q 'warning: unrecognized key "totally_unknown_key"'
```

## A removed key is named as removed, not as a typo

`workspace_mode` and `prefer_solo` were real settings until 4.0. A key that
used to work and silently stopped is a different problem from a misspelling, so
validation says which one it is:

```sh
cat > .sddx/config.json <<'EOF'
{
  "workspace_mode": "branch",
  "prefer_solo": true
}
EOF
```

```sh
./sddx config validate 2>&1 | grep -q '"workspace_mode" removed in sddx 4.0'
./sddx config validate 2>&1 | grep -q '"prefer_solo" removed in sddx 4.0'
```

Neither changes how anything runs — worktree is the only workspace strategy,
and a trivial task is a one-node run. Delete them.

## Unparseable JSON is the one case that fails outright

```sh
echo '{ not json' > .sddx/config.json
```

```sh
./sddx config validate 2>&1 | grep -q "is not valid JSON"
```

```sh
rm .sddx/config.json
```

## Structured output for automation

```sh
./sddx config show --output json | grep -o '"stuck_threshold": [0-9]*'
```
