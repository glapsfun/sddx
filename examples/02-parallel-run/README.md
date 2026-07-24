# Example: a parallel multi-task run

Two independent tasks — disjoint file scope, no `depends_on` — registered
together from one `graph.yaml`, each getting its own worktree immediately.
This is the primitive `/sddx:run` automates inside Claude Code: an
orchestrator splits a goal into tasks like these, then hands each worktree to
a separate tdd-executor running concurrently. Here both are driven from one
terminal, one after another, so every command stays copy-pasteable — nothing
about the workflow requires that; each worktree's state is fully independent
of the other's.

## Setup

```sh skip
bash examples/02-parallel-run/setup.sh
```

`cd` into the printed directory before running anything below.

## Write two independent specs and the graph

```sh
ROOT="$PWD"
mkdir -p specs
cat > specs/alpha.yaml <<'EOF'
task: alpha module reports its name
success_criteria:
  - "bun test tests/alpha.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/alpha.test.ts"
  expect: exit 0
scope:
  - "src/alpha/**"
EOF
cat > specs/bravo.yaml <<'EOF'
task: bravo module reports its name
success_criteria:
  - "bun test tests/bravo.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/bravo.test.ts"
  expect: exit 0
scope:
  - "src/bravo/**"
EOF
cat > graph.yaml <<'EOF'
goal: add two independent modules
tasks:
  - alias: alpha
    spec: specs/alpha.yaml
  - alias: bravo
    spec: specs/bravo.yaml
EOF
```

## Register the graph

```sh
OUT=$("$ROOT/sddx" graph create --graph graph.yaml)
echo "$OUT"
ALPHA_ID=$(echo "$OUT" | grep -E '^ *alpha →' | awk '{print $3}')
BRAVO_ID=$(echo "$OUT" | grep -E '^ *bravo →' | awk '{print $3}')
```

Two independent worktrees exist right now, before either task is touched:

```sh
test -d "$ROOT/.sddx-worktrees/$ALPHA_ID" && test -d "$ROOT/.sddx-worktrees/$BRAVO_ID"
```

## Drive alpha through the loop, inside its own worktree

```sh
cd "$ROOT/.sddx-worktrees/$ALPHA_ID"
mkdir -p src/alpha tests
cat > tests/alpha.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { alphaName } from "../src/alpha/mod";

test("alpha module reports its name", () => {
  expect(alphaName()).toBe("alpha");
});
EOF
```

```sh expect=1
bun test tests/alpha.test.ts
```

```sh
"$ROOT/sddx" task phase "$ALPHA_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$ALPHA_ID"
cat > src/alpha/mod.ts <<'EOF'
export function alphaName(): string {
  return "alpha";
}
EOF
bun test tests/alpha.test.ts
"$ROOT/sddx" task phase "$ALPHA_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$ALPHA_ID" VERIFY
"$ROOT/sddx" verify "$ALPHA_ID"
```

## Drive bravo the same way, in parallel — here, right after

```sh
cd "$ROOT/.sddx-worktrees/$BRAVO_ID"
mkdir -p src/bravo tests
cat > tests/bravo.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { bravoName } from "../src/bravo/mod";

test("bravo module reports its name", () => {
  expect(bravoName()).toBe("bravo");
});
EOF
```

```sh expect=1
bun test tests/bravo.test.ts
```

```sh
"$ROOT/sddx" task phase "$BRAVO_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$BRAVO_ID"
cat > src/bravo/mod.ts <<'EOF'
export function bravoName(): string {
  return "bravo";
}
EOF
bun test tests/bravo.test.ts
"$ROOT/sddx" task phase "$BRAVO_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$BRAVO_ID" VERIFY
"$ROOT/sddx" verify "$BRAVO_ID"
```

## Check the board from the main checkout

```sh
cd "$ROOT"
"$ROOT/sddx" board
```

Both rows read `Completed` — two tasks, two worktrees, two receipts, zero
merge conflicts in `.sddx/`. Shipping this goal as one PR is
[examples/08-pr-from-goal](../08-pr-from-goal/).
