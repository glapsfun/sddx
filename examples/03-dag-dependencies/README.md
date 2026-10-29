# Example: dependencies, fan-out and fan-in

Tasks that touch the same files cannot run at the same time; a dependency
orders them. This example shows the plan gate refusing an unordered overlap,
then a fan-out and fan-in graph running in order. See
[model-dag-dependencies](../../docs/how-to/model-dag-dependencies.md).

## Setup

```sh skip
bash examples/03-dag-dependencies/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-pipeline.md
GOAL=2026-01-01-pipeline
mkdir -p .sddx/specs
```

## Overlap without order is refused

Two tasks may both write `src/shared.ts`, and nothing orders them:

```sh
cat > "$SPEC" <<'EOF'
# Pipeline

## Design

### Goal
A three-stage pipeline.

### Acceptance
- every stage writes its marker file

### Non-goals

### Assumptions

### Open decisions

## Tasks

### p-a First

~~~sddx
oracle: {type: command, run: test -f a.done, expect: exit 0}
scope: [a.done, src/shared.ts]
~~~

### p-b Second

~~~sddx
oracle: {type: command, run: test -f b.done, expect: exit 0}
scope: [b.done, src/shared.ts]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: pipeline (draft)"
```

```sh expect=1
"$SDDX" plan check "$SPEC"
```

```sh
"$SDDX" plan check "$SPEC" 2>&1 | grep 'scope overlap between concurrent tasks "p-a" and "p-b"'
```

## Order them, and add a fan-in

`p-b` and `p-c` both follow `p-a` (fan-out), and `p-d` follows both (fan-in).
`p-b` and `p-c` can run at the same time, so their scopes are disjoint.

```sh
cat > "$SPEC" <<'EOF'
# Pipeline

## Design

### Goal
A three-stage pipeline.

### Acceptance
- every stage writes its marker file

### Non-goals

### Assumptions

### Open decisions

## Tasks

### p-a Base

~~~sddx
oracle: {type: command, run: test -f a.done, expect: exit 0}
scope: [a.done]
~~~

### p-b Left

~~~sddx
oracle: {type: command, run: test -f a.done && test -f b.done, expect: exit 0}
scope: [b.done]
depends_on: p-a
~~~

### p-c Right

~~~sddx
oracle: {type: command, run: test -f a.done && test -f c.done, expect: exit 0}
scope: [c.done]
depends_on: p-a
~~~

### p-d Join

~~~sddx
oracle: {type: command, run: test -f b.done && test -f c.done && test -f d.done, expect: exit 0}
scope: [d.done]
depends_on: [p-b, p-c]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: pipeline"
"$SDDX" plan check "$SPEC"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
```

A small helper finishes one task: start it, write its marker, verify, review.

```sh
finish() {
  "$SDDX" task start "$1" > /dev/null
  echo done > "$ROOT/.sddx-worktrees/$1/$2.done"
  "$SDDX" verify "$1" > /dev/null
  "$SDDX" review record "$1" --verdict pass --reviewer you > /dev/null
}
```

## Only the root can start

```sh
"$SDDX" task ready --goal "$GOAL"
```

```sh expect=1
"$SDDX" task start p-d
```

```sh
"$SDDX" task start p-d 2>&1 | grep "dependency p-b is PLANNED, not DONE"
```

```sh
finish p-a a
"$SDDX" task ready --goal "$GOAL"
finish p-b b
finish p-c c
```

`p-d` forks from `p-b`'s commit with `p-c`'s merged in, so its worktree already
has every parent's work:

```sh
"$SDDX" task start p-d
ls "$ROOT/.sddx-worktrees/p-d/"*.done
echo done > "$ROOT/.sddx-worktrees/p-d/d.done"
"$SDDX" verify p-d
"$SDDX" review record p-d --verdict pass --reviewer you
"$SDDX" run report --goal "$GOAL"
```
