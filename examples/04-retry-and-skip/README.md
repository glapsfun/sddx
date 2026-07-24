# Example: retry and skip/block policy

Part 1: a task with `retry.max_attempts: 2` resets to `PLAN` instead of
terminating the first time it's abandoned, then truly abandons on the
second. Part 2: once a parent is genuinely `ABANDONED`, its `skip`-policy
dependent shows **Skipped** on the board while its `block`-policy dependent
stays **Blocked**.

## Setup

```sh skip
bash examples/04-retry-and-skip/setup.sh
```

`cd` into the printed directory before running anything below.

## Part 1: a bounded retry

```sh
ROOT="$PWD"
cat > spec.yaml <<'EOF'
task: flaky root task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
retry:
  max_attempts: 2
  workspace: fresh
EOF
OUT=$(./sddx task create --spec spec.yaml --workspace worktree)
echo "$OUT"
ID=$(echo "$OUT" | grep '^created' | awk '{print $2}')
BASE=$(git -C ".sddx-worktrees/$ID" rev-parse HEAD)
```

```sh
cd ".sddx-worktrees/$ID"
"$ROOT/sddx" task phase "$ID" RED --test-exit 1
"$ROOT/sddx" task phase "$ID" GREEN --test-exit 0
```

First abandon: attempts remain, so this **retries** instead of terminating —
watch for `retry 2/2` in the output:

```sh
"$ROOT/sddx" task phase "$ID" ABANDONED 2>&1 | grep -q "retry 2/2"
```

`workspace: fresh` just discarded and recreated the directory we're sitting
in — re-enter it so the shell's own notion of "here" isn't stale:

```sh
cd "$ROOT"
cd ".sddx-worktrees/$ID"
```

```sh
"$ROOT/sddx" task show "$ID" | grep -q '"phase": "PLAN"'
"$ROOT/sddx" task show "$ID" | grep -q '"attempt_count": 2'
```

`workspace: fresh` (the default) re-forked the same worktree back to its
original base — same path, clean history:

```sh
[ "$(git rev-parse HEAD)" = "$BASE" ]
```

Second attempt exhausts the budget — this time it's a real abandon, no
`retry` mention:

```sh
"$ROOT/sddx" task phase "$ID" RED --test-exit 1
"$ROOT/sddx" task phase "$ID" GREEN --test-exit 0
OUT2=$("$ROOT/sddx" task phase "$ID" ABANDONED)
echo "$OUT2"
```

```sh expect=1
echo "$OUT2" | grep -q "retry"
```

```sh
"$ROOT/sddx" task show "$ID" | grep -q '"phase": "ABANDONED"'
cd "$ROOT"
```

## Part 2: skip vs. block once a parent is abandoned

```sh
mkdir -p specs
cat > specs/parent.yaml <<'EOF'
task: unrecoverable parent task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
EOF
cat > specs/skip-child.yaml <<'EOF'
task: skip-policy dependent
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
EOF
cat > specs/block-child.yaml <<'EOF'
task: block-policy dependent
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
on_dependency_failure: block
EOF
cat > graph2.yaml <<'EOF'
goal: skip vs block demonstration
tasks:
  - alias: parent
    spec: specs/parent.yaml
  - alias: skip-child
    spec: specs/skip-child.yaml
    depends_on: parent
  - alias: block-child
    spec: specs/block-child.yaml
    depends_on: parent
EOF
```

`skip-child` omits `on_dependency_failure` (default `skip`); `block-child`
sets it explicitly.

```sh
OUT3=$(./sddx graph create --graph graph2.yaml)
echo "$OUT3"
PARENT_ID=$(echo "$OUT3" | grep -E '^ *parent →' | awk '{print $3}')
SKIP_ID=$(echo "$OUT3" | grep -E '^ *skip-child →' | awk '{print $3}')
BLOCK_ID=$(echo "$OUT3" | grep -E '^ *block-child →' | awk '{print $3}')
```

No `retry` in `parent`'s spec, so the first abandon is immediate and final:

```sh
cd ".sddx-worktrees/$PARENT_ID"
"$ROOT/sddx" task phase "$PARENT_ID" RED --test-exit 1
"$ROOT/sddx" task phase "$PARENT_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$PARENT_ID" ABANDONED
cd "$ROOT"
```

```sh
./sddx board >/dev/null && grep -q "$SKIP_ID | Skipped skipped-on-$PARENT_ID" .sddx/BOARD.md
./sddx board >/dev/null && grep -q "$BLOCK_ID | Blocked" .sddx/BOARD.md
```

The rest of a real goal keeps moving past the skip-policy dependent; the
block-policy one stays blocked and escalates.
