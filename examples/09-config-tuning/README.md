# Example: config

How `.sddx/config.json` resolves, how environment variables override the keys
that allow it, which keys deliberately do not, and what `config validate`
reports. See [config.md](../../docs/reference/config.md).

## Setup

```sh skip
bash examples/09-config-tuning/setup.sh
```

## No file, defaults

```sh
./sddx config show | grep "^stuck_threshold: 3$"
./sddx config show | grep "^interaction_mode: human$"
./sddx config show | grep "^profile: default$"
```

## A file, and the environment on top

```sh
mkdir -p .sddx
cat > .sddx/config.json <<'EOF'
{
  "schema_version": "2.0",
  "stuck_threshold": 5,
  "verbose": true
}
EOF
./sddx config show | grep "^stuck_threshold: 5$"
./sddx config show | grep "stuck_threshold: source=config"
SDDX_STUCK_THRESHOLD=7 ./sddx config show | grep "^stuck_threshold: 7$"
```

## Gate keys ignore the environment

`interaction_mode`, `auto_max_tasks` and `profile` are read from the file only,
so the agent a gate constrains cannot switch the gate off from its own command
line:

```sh
SDDX_INTERACTION_MODE=auto ./sddx config show | grep "^interaction_mode: human$"
```

## Validation

`config validate` exits 1 on any issue and names each one:

```sh
cat > .sddx/config.json <<'EOF'
{
  "schema_version": "2.0",
  "stuck_threshold": -2,
  "profile": "strikt",
  "runtime_scope": "global",
  "totally_unknown_key": true
}
EOF
```

```sh expect=1
./sddx config validate
```

```sh
./sddx config validate 2>&1 | grep '"stuck_threshold" must be a positive integer'
./sddx config validate 2>&1 | grep '"profile" must be one of default|strict'
./sddx config validate 2>&1 | grep '"runtime_scope" removed in sddx 6'
./sddx config validate 2>&1 | grep 'unrecognized key "totally_unknown_key"'
```

An invalid `profile` fails closed: it resolves to `strict`, never `default`.

```sh
./sddx config show | grep "^profile: strict$"
```

A config written by sddx 5 is recognized as such:

```sh
echo '{"schema_version": "1.0"}' > .sddx/config.json
./sddx config validate 2>&1 | grep "written by sddx 5"
rm .sddx/config.json
./sddx config show --output json | grep -o '"stuck_threshold": [0-9]*'
```
