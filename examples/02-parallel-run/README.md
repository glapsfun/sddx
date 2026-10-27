# Example: two tasks in parallel

Two independent tasks, each in its own worktree, worked on at the same time and
merged into one run branch. Builds on
[01-single-task](../01-single-task/README.md).

## Setup

```sh skip
bash examples/02-parallel-run/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-strings.md
GOAL=2026-01-01-strings
```

## Two tasks with disjoint scopes

Tasks with no dependency between them may run at the same time, so their
scopes must not overlap. `plan check` proves that before anything starts.

```sh
mkdir -p .sddx/specs
cat > "$SPEC" <<'EOF'
# String helpers

## Design

### Goal
Two small string helpers.

### Acceptance
- upper("ab") returns "AB"
- reverse("ab") returns "ba"

### Non-goals

### Assumptions

### Open decisions

## Tasks

### s-upper Upper case

~~~sddx
oracle: {type: command, run: bun test tests/upper.test.ts, expect: exit 0}
scope: [src/upper.ts]
~~~

### s-reverse Reverse

~~~sddx
oracle: {type: command, run: bun test tests/reverse.test.ts, expect: exit 0}
scope: [src/reverse.ts]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: strings"
"$SDDX" plan check "$SPEC"
"$SDDX" plan approve "$SPEC"
"$SDDX" plan start "$SPEC"
```

## Both are ready, so start both

```sh
"$SDDX" task ready --goal "$GOAL"
"$SDDX" task start s-upper
"$SDDX" task start s-reverse
git worktree list
```

Each worktree sees only its own task. In a harness, an orchestrator would hand
each one to its own worker here.

```sh
U="$ROOT/.sddx-worktrees/s-upper"
R="$ROOT/.sddx-worktrees/s-reverse"
mkdir -p "$U/tests" "$U/src" "$R/tests" "$R/src"
cat > "$U/tests/upper.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { upper } from "../src/upper";
test("upper", () => expect(upper("ab")).toBe("AB"));
EOF
echo 'export const upper = (s: string): string => s.toUpperCase();' > "$U/src/upper.ts"
cat > "$R/tests/reverse.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { reverse } from "../src/reverse";
test("reverse", () => expect(reverse("ab")).toBe("ba"));
EOF
echo 'export const reverse = (s: string): string => [...s].reverse().join("");' > "$R/src/reverse.ts"
```

## Verify and review each

```sh
"$SDDX" verify s-upper
"$SDDX" verify s-reverse
"$SDDX" review record s-upper --verdict pass --reviewer you
"$SDDX" review record s-reverse --verdict pass --reviewer you
```

Each review merged its task into the run branch. The two receipts are siblings:
both chain onto the same parent, because neither task saw the other.

```sh
"$SDDX" run report --goal "$GOAL"
git log --oneline --graph "sddx/run-$GOAL"
```
