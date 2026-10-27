# Example: oracle types

`command`, `test-suite` and `browser` oracles run the same way: `sddx verify`
executes `run` in the proof worktree, twice over (RED, then GREEN). The type
tells a reader what the command proves; it never changes the mechanics.
`manual` is different: nobody can execute it, so `verify` refuses it and `auto`
mode refuses any plan containing one. See
[choose-an-oracle-type](../../docs/how-to/choose-an-oracle-type.md).

## Setup

```sh skip
bash examples/06-oracle-types/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-oracles.md
mkdir -p .sddx/specs
```

## Three executable types, one manual

`runs: 3` on the test suite makes the GREEN half run three times; every run
must pass. A real `browser` oracle would run something like
`bunx playwright test e2e/login.spec.ts`; this one is a stand-in so the example
runs offline.

```sh
cat > "$SPEC" <<'EOF'
# Oracle types

## Design

### Goal
Show every oracle type.

### Acceptance
- each executable oracle passes after its change

### Non-goals

### Assumptions

### Open decisions

## Tasks

### o-cmd Command

~~~sddx
oracle: {type: command, run: test -f cmd.done, expect: exit 0}
scope: [cmd.done]
~~~

### o-suite Test suite

~~~sddx
oracle: {type: test-suite, run: test -f suite.done, expect: exit 0, runs: 3}
scope: [suite.done]
~~~

### o-browser Browser

~~~sddx
oracle: {type: browser, run: test -f browser.done, expect: exit 0}
scope: [browser.done]
~~~

### o-manual Manual

~~~sddx
oracle: {type: manual}
scope: [manual.done]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: oracles"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
```

## The executable types prove themselves the same way

```sh
for T in cmd suite browser; do
  ID="o-$T"
  "$SDDX" task start "$ID" > /dev/null
  echo done > "$ROOT/.sddx-worktrees/$ID/$T.done"
  "$SDDX" verify "$ID"
  "$SDDX" review record "$ID" --verdict pass --reviewer you > /dev/null
done
"$SDDX" task show o-suite | grep -c '"exit_code": 0' | grep -q 3
"$SDDX" task show o-suite | grep -q '"exit_code": 1'
```

The suite's record holds its failing RED run plus three passing GREEN runs.

## `manual` needs a person

```sh
"$SDDX" task start o-manual
```

```sh expect=1
"$SDDX" verify o-manual
```

```sh
"$SDDX" verify o-manual 2>&1 | grep "manual oracle, which needs a human"
```

Unattended, the plan would never have started:

```sh
SPEC2=.sddx/specs/2026-01-02-manual-auto.md
cat > "$SPEC2" <<'EOF'
# Manual, unattended

## Design

### Goal
Show auto mode refusing a manual oracle.

### Acceptance
- a person confirms the page looks right

### Non-goals

### Assumptions

### Open decisions

## Tasks

### m-auto Visual check

~~~sddx
oracle: {type: manual}
scope: [m.done]
~~~
EOF
git add "$SPEC2"
git commit -q -m "plan: manual in auto"
echo '{"schema_version": "2.0", "interaction_mode": "auto"}' > .sddx/config.json
"$SDDX" plan start "$SPEC2" 2>&1 | grep "declares oracle.type: manual"
```
