# Example: shipping a goal as a PR

`sddx pr create` pushes a goal's run branch as it stands and opens a PR from it,
with a body built from the receipts of the tasks merged so far. This example
runs the parts that need no network: a partly finished goal, its run report, and
the refusal when the PR host cannot be determined. See
[ship-a-goal-as-a-pr](../../docs/how-to/ship-a-goal-as-a-pr.md).

## Setup

```sh skip
bash examples/08-pr-from-goal/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-ship.md
GOAL=2026-01-01-ship
mkdir -p .sddx/specs
cat > "$SPEC" <<'EOF'
# Ship

## Design

### Goal
Two independent changes.

### Acceptance
- both markers exist

### Non-goals

### Assumptions

### Open decisions

## Tasks

### a Alpha

~~~sddx
oracle: {type: command, run: test -f a.done, expect: exit 0}
scope: [a.done]
~~~

### b Beta

~~~sddx
oracle: {type: command, run: test -f b.done, expect: exit 0}
scope: [b.done]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: ship"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
```

## Finish only `a`

```sh
"$SDDX" task start a
echo done > "$ROOT/.sddx-worktrees/a/a.done"
"$SDDX" verify a
"$SDDX" review record a --verdict pass --reviewer you
```

The run report shows where things stand. There is no completeness gate: a PR
can carry a partial goal, and its body says how much is outstanding.

```sh
"$SDDX" run report --goal "$GOAL" | grep "1 of 2 task(s) merged"
```

## Refusal: no PR host

This sandbox has no `origin` remote, so `pr create` refuses before touching git:

```sh expect=1
"$SDDX" pr create --goal "$GOAL"
```

```sh
"$SDDX" pr create --goal "$GOAL" 2>&1 | grep 'cannot determine PR host from the "origin" remote'
git branch -r | wc -l | grep -q 0
```

Set `pr_host` (`gh` or `glab`) in `.sddx/config.json`, or add a GitHub or GitLab
`origin` remote, and the same command pushes `sddx/run-2026-01-01-ship` and the
goal ref and opens the PR. Merging that PR is your decision.

```sh skip
sddx pr create --goal 2026-01-01-ship
```
