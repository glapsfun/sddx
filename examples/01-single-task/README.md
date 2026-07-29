# Example: a single task, start to finish

**A single task is a one-node run.** There is no separate small-task mode — the
same graph, run branch, worktree, oracle, and receipt apply whether the plan has
one node or ten. This example walks that one-node run by hand, one command at a
time; it is what `/sddx:run` drives for you inside Claude Code. Every other
example builds on it.

## Setup

From the repo root:

```sh skip
bash examples/01-single-task/setup.sh
```

This prints a scratch directory with a local `./sddx` shim. `cd` there before
running anything below. Installed sddx globally instead (see
[install-sddx.md](../../docs/how-to/install-sddx.md))? Use plain `sddx`
throughout.

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
```

`$SDDX` is an absolute path because the TDD loop below runs inside the task's
own worktree, where the `./sddx` shim at the repo root is not on the path.

## Write the spec

```sh
cat > spec.yaml <<'EOF'
task: health check returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
scope:
  - "health.ts"
  - "tests/**"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
EOF
```

`scope` is this task's write lane. Declaring it is what lets the graph gate
prove tasks can run concurrently without colliding.

## Write the graph

Even one task needs a goal, because the goal is what owns the run branch:

```sh
cat > graph.yaml <<'EOF'
schema_version: "1.0"
interaction_mode: human
goal: health endpoint reports ok
tasks:
  - alias: health
    spec: spec.yaml
EOF
```

## Check the plan without creating anything

```sh
"$SDDX" graph create --graph graph.yaml --dry-run
```

`--dry-run` validates every spec, resolves the base SHA, and reports exactly
what a real create would produce — writing nothing. A missing oracle, an id
collision, or a scope overlap the graph does not order is refused here.

## Approve and create the run

```sh
"$SDDX" graph approve --graph graph.yaml
```

```sh
OUT=$("$SDDX" graph create --graph graph.yaml)
echo "$OUT"
ID=$(echo "$OUT" | grep -o 'created [0-9]\{8\}-[a-z0-9-]*' | head -1 | awk '{print $2}')
WT="$ROOT/.sddx-worktrees/$ID"
```

That one command created the run branch, the task's `sddx/<id>` branch, its
worktree, and the goal record — atomically. If any step had failed, none of it
would exist.

```sh
cd "$WT"
```

The rest of the loop runs **inside the worktree**. Your own checkout is
untouched and stays writable throughout.

## Write the failing test first

```sh
mkdir -p tests
cat > tests/health.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { health } from "../health";

test("health check returns ok", () => {
  expect(health()).toEqual({ status: "ok" });
});
EOF
```

`../health` doesn't exist yet — the run below fails, which is the point.

```sh expect=1
bun test tests/health.test.ts
```

## Move to RED, with real proof

```sh
"$SDDX" task phase "$ID" RED --test-exit 1
```

`--test-exit` is checked, not trusted — a `0` here is refused. Now record
that the spec's own oracle (the same command) fails too, while the
implementation still doesn't exist — `sddx verify` later refuses without
this:

```sh
"$SDDX" red-check "$ID"
```

## Implement, watch it go green

```sh
cat > health.ts <<'EOF'
export function health(): { status: string } {
  return { status: "ok" };
}
EOF
```

```sh
bun test tests/health.test.ts
```

```sh
"$SDDX" task phase "$ID" GREEN --test-exit 0
```

## Verify

```sh
"$SDDX" task phase "$ID" VERIFY
```

```sh
"$SDDX" verify "$ID"
```

On success this writes `.sddx/receipts/$ID.json`, makes one atomic commit
containing `health.ts`, `tests/health.test.ts`, the spec, and the receipt, and
merges the task into its run branch.

## Check the board and the chain

```sh
"$SDDX" board
```

```sh
"$SDDX" audit
```

`audit` re-walks the receipt chain and exits 0 on `chain intact`. See
[examples/07-receipts-and-audit](../07-receipts-and-audit/) for what happens
when it isn't.

## What was NOT touched

```sh
cd "$ROOT"
git rev-parse --abbrev-ref HEAD
```

Still `main`. A run ends on its own branch with a receipt chain — merging into
your target branch is always your decision, in every mode.
