# Example: shipping a goal as a PR from its run branch

Every `graph create` now creates a **run branch** (`sddx/run-<goal-id>`)
before any task starts, and `sddx verify` merges each task into it
automatically as it passes — no gate waiting for the whole goal to finish.
`sddx pr create --goal <id>` just pushes that branch and opens a PR/MR from
it: a **partial** goal is a perfectly valid thing to ship, not a refusal.
This example proves that directly, plus the one refusal that still applies
(an unresolvable PR host) — both pure and local, no network call in either
case. The real command (push + `gh`/`glab`) is shown at the end for
reference, but not run.

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
RUN_BRANCH=$(echo "$OUT" | grep -o 'run_branch=[^ ]*' | cut -d= -f2)
```

## Finish only `a` — the run branch reflects it immediately

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

`b` is never touched — still `PLAN`. The run report already shows exactly
where things stand, with no completeness gate blocking it:

```sh
./sddx run report --goal "$GOAL_ID" 2>&1 | grep -q "1 of 2 task(s) merged"
```

## Refusal: an undetectable PR host

This sandbox has no `origin` remote (`setup.sh` never added one), so even
pushing a partially-merged run branch refuses before touching git —
resolving the PR host comes before the push, regardless of how much of the
goal is done:

```sh
./sddx pr create --goal "$GOAL_ID" 2>&1 | grep -q 'cannot determine PR host from the "origin" remote'
```

No branch was pushed, nothing was mutated — the refusal happens before any
git mutation. Setting `userConfig.pr_host` (`gh` or `glab`) — see
[tune-config.md](../../docs/how-to/tune-config.md) — or having a recognized
`origin` remote (`github.com` or `gitlab.com`) resolves this without
changing anything else about the flow.

## What a real invocation does (not run here)

With a real `origin` remote and an authenticated `gh`/`glab`:

```sh skip
sddx pr create --goal "$GOAL_ID"
```

Pushes `sddx/run-$GOAL_ID` exactly as it stands — no reconstruction, no
cherry-picking — and opens the PR with a body generated from the receipts of
whichever tasks have actually merged (here, just `a`; `b`'s absence is stated
as an outstanding count, never silently implied as done). Finishing `b`
later and re-running `verify` on it merges it into the same run branch
automatically; running `pr create` again would refuse (`already shipped`)
once a PR has opened — the next step at that point is `next-actions --goal
"$GOAL_ID"`, which offers pushing further commits or merging the run branch
into the target branch instead.
