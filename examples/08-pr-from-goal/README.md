# Example: shipping a goal as a PR

`sddx pr create` refuses loudly, before any git mutation, in two ways this
example proves directly: an incomplete goal, and a host it can't resolve.
Both are pure and local — no network call happens in either case. The real
command (push + `gh`/`glab`) is shown at the end for reference, but not run.

## Setup

```sh skip
bash examples/08-pr-from-goal/setup.sh
```

`cd` into the printed directory before running anything below.

## Register a two-task goal

```sh
ROOT="$PWD"
mkdir -p specs
cat > specs/a.yaml <<'EOF'
task: pr example task a
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
task: pr example task b
success_criteria:
  - "b.done exists"
oracle:
  type: command
  run: "test -f b.done"
  expect: exit 0
scope:
  - "src/b/**"
EOF
cat > graph.yaml <<'EOF'
goal: ship two tasks together
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
EOF
OUT=$(./sddx graph create --graph graph.yaml)
echo "$OUT"
GOAL_ID=$(echo "$OUT" | grep -o 'created goal [^ ]*' | awk '{print $3}')
A_ID=$(echo "$OUT" | grep -E '^ *a →' | awk '{print $3}')
B_ID=$(echo "$OUT" | grep -E '^ *b →' | awk '{print $3}')
```

## Refusal 1: an incomplete goal

Complete only `a`:

```sh
cd ".sddx-worktrees/$A_ID"
"$ROOT/sddx" task phase "$A_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$A_ID"
touch a.done
"$ROOT/sddx" task phase "$A_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$A_ID" VERIFY
"$ROOT/sddx" verify "$A_ID"
cd "$ROOT"
```

```sh
./sddx pr create --goal "$GOAL_ID" 2>&1 | grep -q "is not complete — blocking: $B_ID"
```

No branch was created, nothing was pushed — the refusal happens before any
git mutation.

## Refusal 2: an undetectable PR host

Finish `b` too:

```sh
cd ".sddx-worktrees/$B_ID"
"$ROOT/sddx" task phase "$B_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$B_ID"
touch b.done
"$ROOT/sddx" task phase "$B_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$B_ID" VERIFY
"$ROOT/sddx" verify "$B_ID"
cd "$ROOT"
```

This sandbox has no `origin` remote (`setup.sh` never added one), so even a
fully complete goal is refused — again, before any git mutation:

```sh
./sddx pr create --goal "$GOAL_ID" 2>&1 | grep -q 'cannot determine PR host from the "origin" remote'
```

Setting `userConfig.pr_host` (`gh` or `glab`) — see
[tune-config.md](../../docs/how-to/tune-config.md) — or having a recognized
`origin` remote (`github.com` or `gitlab.com`) resolves this without
changing anything else about the flow.

## What a real invocation does (not run here)

With a real `origin` remote and an authenticated `gh`/`glab`:

```sh skip
sddx pr create --goal "$GOAL_ID"
```

Cherry-picks each task's atomic commit (task-creation order) onto a fresh
`sddx/goal-$GOAL_ID` branch, pushes it, and opens the PR with a body
generated from the tasks' receipts — never hand-written. On success it marks
every task and the goal `shipped`, which is what lets `sddx cleanup` later
remove a cherry-picked task branch despite it never looking git-merged by
ancestry.
