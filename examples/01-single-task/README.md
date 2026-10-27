# Example: a single task, start to finish

One goal with one task, driven by hand from the CLI: write the spec, plan it,
start the task, make the change, prove it, review it. This is the loop the sddx
skills drive for you inside a harness. Every other example builds on it.

## Setup

From the repo root:

```sh skip
bash examples/01-single-task/setup.sh
```

This prints a scratch repository with a local `./sddx` shim. `cd` there before
running anything below. With sddx installed, use plain `sddx` throughout.

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-health.md
```

## Write the spec

A goal is one markdown file. The Design section is for people; the fenced
`sddx` block under each task is what sddx checks. Backtick or tilde fences both
work; this example uses tildes only because the spec sits inside a shell
heredoc.

```sh
mkdir -p .sddx/specs
cat > "$SPEC" <<'EOF'
# Health check

## Design

### Goal
A health function reports that the service is up.

### Acceptance
- health() returns {status: "ok"}

### Non-goals
- an HTTP endpoint

### Assumptions
- a plain function is enough for now

### Open decisions

## Tasks

### health-1 Health function

~~~sddx
oracle:
  type: command
  run: bun test tests/health.test.ts
  expect: exit 0
scope: [health.ts]
~~~
EOF
"$SDDX" spec check "$SPEC"
```

The plan you approve has to be in your history, so commit the spec:

```sh
git add "$SPEC"
git commit -q -m "plan: health"
```

## Check, approve and start the plan

```sh
"$SDDX" plan check "$SPEC"
```

`plan check` writes nothing. In the default `human` mode, starting without an
approval is refused with exit 3:

```sh expect=3
"$SDDX" plan start "$SPEC"
```

```sh
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
```

That created the run branch `sddx/run-2026-01-01-health` and one `PLANNED`
task. Nothing else exists yet: no worktree, no branch per task.

## Start the task

```sh
"$SDDX" task start health-1
WT="$ROOT/.sddx-worktrees/health-1"
```

The task now has its own worktree on branch `sddx/health-1`. Your checkout is
untouched and stays yours.

## Write the test, then prove it is not enough

```sh
mkdir -p "$WT/tests"
cat > "$WT/tests/health.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { health } from "../health";

test("health check returns ok", () => {
  expect(health()).toEqual({ status: "ok" });
});
EOF
```

`verify` refuses: the oracle cannot pass yet.

```sh expect=1
"$SDDX" verify health-1
```

## Implement, then verify

```sh
cat > "$WT/health.ts" <<'EOF'
export function health(): { status: string } {
  return { status: "ok" };
}
EOF
"$SDDX" verify health-1
```

Verify proved two things in a throwaway worktree: the oracle fails on the base
commit with only your new test applied, and passes on your change. The task is
now `IN_REVIEW`. Nothing has been committed yet.

## Review

A review is recorded against exactly the diff that was proven. A failing review
sends the task back; a passing one finalizes it:

```sh
"$SDDX" review record health-1 --verdict pass --reviewer you
```

That made one commit holding the code, the task state and a receipt, and merged
it into the run branch.

## Look at the result

```sh
"$SDDX" board
"$SDDX" run report --goal 2026-01-01-health
git rev-parse --abbrev-ref HEAD
```

Your branch is still `main`. Merging the run branch into it is your decision:

```sh
git merge -q --no-ff -m "merge health" sddx/run-2026-01-01-health
"$SDDX" audit
```
