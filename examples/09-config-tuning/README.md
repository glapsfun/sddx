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
./sddx config show | grep -q "^workspace_mode: auto$"
```

## Override via `.sddx/config.json`

```sh
mkdir -p .sddx
cat > .sddx/config.json <<'EOF'
{
  "workspace_mode": "branch",
  "stuck_threshold": 5,
  "verbose": true
}
EOF
./sddx config show | grep -q "^workspace_mode: branch$"
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
  "workspace_mode": "sideways",
  "totally_unknown_key": true
}
EOF
```

```sh
./sddx config validate 2>&1 | grep -q 'warning: "workspace_mode" must be one of'
./sddx config validate 2>&1 | grep -q 'warning: unrecognized key "totally_unknown_key"'
```

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
