# Example: retry, skip and block

What happens when a task is abandoned: a retry policy gives it another attempt,
and its dependents are either skipped (the default) or halt the goal. See
[configure-retry-and-skip](../../docs/how-to/configure-retry-and-skip.md).

## Setup

```sh skip
bash examples/04-retry-and-skip/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
mkdir -p .sddx/specs
```

## A retry gives a fresh attempt

```sh
SPEC=.sddx/specs/2026-01-01-retry.md
cat > "$SPEC" <<'EOF'
# Retry

## Design

### Goal
Show a retry.

### Acceptance
- r-1 writes its marker

### Non-goals

### Assumptions

### Open decisions

## Tasks

### r-1 Flaky approach

~~~sddx
oracle: {type: command, run: test -f r.done, expect: exit 0}
scope: [r.done]
retry: {max_attempts: 2, workspace: fresh}
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: retry"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
"$SDDX" task start r-1
echo "a bad first attempt" > "$ROOT/.sddx-worktrees/r-1/scratch.txt"
```

Abandoning with attempts left sends the task back to `PLANNED`, and a `fresh`
retry throws the worktree away:

```sh
"$SDDX" task abandon r-1 --reason "wrong approach"
test ! -e "$ROOT/.sddx-worktrees/r-1"
"$SDDX" task start r-1
test ! -e "$ROOT/.sddx-worktrees/r-1/scratch.txt"
```

The second abandon has no attempts left, so the task is `ABANDONED`:

```sh
"$SDDX" task abandon r-1 --reason "still wrong"
"$SDDX" board
grep "r-1.*ABANDONED.*still wrong" .sddx/BOARD.md
```

## A failed ancestor skips its dependents

`on_dependency_failure: skip` is the default. The dependent is abandoned as
`skipped`, and independent work carries on:

```sh
SPEC=.sddx/specs/2026-01-01-skip.md
cat > "$SPEC" <<'EOF'
# Skip

## Design

### Goal
Show skip.

### Acceptance
- k-3 still finishes

### Non-goals

### Assumptions

### Open decisions

## Tasks

### k-1 Parent

~~~sddx
oracle: {type: command, run: test -f k1.done, expect: exit 0}
scope: [k1.done]
~~~

### k-2 Child

~~~sddx
oracle: {type: command, run: test -f k2.done, expect: exit 0}
scope: [k2.done]
depends_on: k-1
~~~

### k-3 Independent

~~~sddx
oracle: {type: command, run: test -f k3.done, expect: exit 0}
scope: [k3.done]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: skip"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
"$SDDX" task start k-1
"$SDDX" task abandon k-1 --reason "dead end"
"$SDDX" task show k-2 | grep '"abandon_reason": "skipped"'
"$SDDX" task start k-3
```

## `block` halts the goal instead

```sh
SPEC=.sddx/specs/2026-01-01-block.md
sed -e 's/# Skip/# Block/' -e 's/k-/b-/g' -e 's/k1/b1/g; s/k2/b2/g; s/k3/b3/g' \
  -e 's/depends_on: b-1/depends_on: b-1\non_dependency_failure: block/' \
  .sddx/specs/2026-01-01-skip.md > "$SPEC"
git add "$SPEC"
git commit -q -m "plan: block"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
"$SDDX" task start b-1
"$SDDX" task abandon b-1 --reason "dead end"
```

Nothing else in that goal can start now, independent tasks included, until a
person decides what to do:

```sh
"$SDDX" task ready --goal 2026-01-01-block | grep "no task can start"
"$SDDX" task start b-3 2>&1 | grep "goal 2026-01-01-block is halted"
```

```sh expect=1
"$SDDX" task start b-3
```
