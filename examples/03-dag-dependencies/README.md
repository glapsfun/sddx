# Example: modeling DAG dependencies

A four-task graph: `a` and `b` are independent roots; `c` depends on `a`
alone; `d` fans in from both `a` and `b`. Demonstrates the overlap ⟹ ordered
scope gate refusing an illegal schedule, then a legal one materializing
correctly — a single-parent dependent forking from its parent's DONE commit,
and a two-parent fan-in child forking from the first parent and merging the
second in.

## Setup

```sh skip
bash examples/03-dag-dependencies/setup.sh
```

`cd` into the printed directory before running anything below.

## First, watch the gate refuse an illegal graph

Two independent tasks (no `depends_on` between them) whose scopes overlap
are illegal — nothing orders their concurrent writes:

```sh
ROOT="$PWD"
mkdir -p bad-specs
cat > bad-specs/x.yaml <<'EOF'
task: illegal x task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/shared/**"
EOF
cat > bad-specs/y.yaml <<'EOF'
task: illegal y task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/shared/**"
EOF
cat > bad-graph.yaml <<'EOF'
goal: illegal concurrent overlap
tasks:
  - alias: x
    spec: bad-specs/x.yaml
  - alias: y
    spec: bad-specs/y.yaml
EOF
```

```sh
./sddx graph create --graph bad-graph.yaml 2>&1 | grep -q "scope overlap between concurrent tasks"
```

`graph create` validates every spec and the whole schedule **before writing
anything** — this refusal leaves no tasks or worktrees behind, so the sandbox
is still clean for the real graph below.

## Register the real graph

```sh
mkdir -p specs
cat > specs/a.yaml <<'EOF'
task: dag example root a
success_criteria:
  - "a.done exists"
oracle:
  type: command
  run: "test -f a.done"
  expect: exit 0
scope:
  - "src/a/**"
EOF
cat > specs/b.yaml <<'EOF'
task: dag example root b
success_criteria:
  - "b.done exists"
oracle:
  type: command
  run: "test -f b.done"
  expect: exit 0
scope:
  - "src/b/**"
EOF
cat > specs/c.yaml <<'EOF'
task: dag example single-parent child c
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/a/child.ts"
EOF
cat > specs/d.yaml <<'EOF'
task: dag example fan-in child d
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/d/**"
EOF
cat > graph.yaml <<'EOF'
goal: ship the dashboard
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
  - alias: c
    spec: specs/c.yaml
    depends_on: a
  - alias: d
    spec: specs/d.yaml
    depends_on: [a, b]
EOF
```

`c`'s scope (`src/a/child.ts`) overlaps `a`'s (`src/a/**`) — legal only
because `c depends_on: a` orders them.

```sh
OUT=$(./sddx graph create --graph graph.yaml)
echo "$OUT"
A_ID=$(echo "$OUT" | grep -E '^ *a →' | awk '{print $3}')
B_ID=$(echo "$OUT" | grep -E '^ *b →' | awk '{print $3}')
C_ID=$(echo "$OUT" | grep -E '^ *c →' | awk '{print $3}')
D_ID=$(echo "$OUT" | grep -E '^ *d →' | awk '{print $3}')
```

`a` and `b` get real worktrees immediately; `c` and `d` are deferred — no
worktree yet, both **Blocked** on the board:

```sh
test -d "$ROOT/.sddx-worktrees/$A_ID" && test -d "$ROOT/.sddx-worktrees/$B_ID"
test ! -d "$ROOT/.sddx-worktrees/$C_ID" && test ! -d "$ROOT/.sddx-worktrees/$D_ID"
./sddx board >/dev/null && grep -q "$C_ID | Blocked" .sddx/BOARD.md
./sddx board >/dev/null && grep -q "$D_ID | Blocked" .sddx/BOARD.md
```

## Complete a — c becomes ready, d stays blocked on b

```sh
cd "$ROOT/.sddx-worktrees/$A_ID"
"$ROOT/sddx" task phase "$A_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$A_ID"
touch a.done
"$ROOT/sddx" task phase "$A_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$A_ID" VERIFY
"$ROOT/sddx" verify "$A_ID"
cd "$ROOT"
```

```sh
./sddx board >/dev/null && grep -q "$C_ID | Ready" .sddx/BOARD.md
./sddx board >/dev/null && grep -q "$D_ID | Blocked" .sddx/BOARD.md
```

## Materialize c — its worktree forks from a's DONE commit

```sh
./sddx task materialize "$C_ID"
```

```sh
[ "$(git -C ".sddx-worktrees/$C_ID" rev-parse HEAD)" = "$(git rev-parse "sddx/$A_ID")" ]
```

## Complete b, then materialize d — a two-parent merge

```sh
cd "$ROOT/.sddx-worktrees/$B_ID"
"$ROOT/sddx" task phase "$B_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$B_ID"
touch b.done
"$ROOT/sddx" task phase "$B_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$B_ID" VERIFY
"$ROOT/sddx" verify "$B_ID"
cd "$ROOT"
```

```sh
./sddx task materialize "$D_ID"
```

`d`'s worktree HEAD is a merge commit with both `a`'s and `b`'s DONE commits
as parents — never a rebase:

```sh
PARENTS=$(git -C ".sddx-worktrees/$D_ID" log -1 --format=%P HEAD)
echo "$PARENTS" | grep -q "$(git rev-parse "sddx/$A_ID")"
echo "$PARENTS" | grep -q "$(git rev-parse "sddx/$B_ID")"
```

## Final board

```sh
./sddx board
```

`a` and `b` read `Completed`; `c` and `d` read `Ready` — materialized, phase
`PLAN`, ready for their own RED→GREEN→VERIFY loop exactly like
[examples/01-single-task](../01-single-task/).
