# Example: a single task, start to finish

The base loop for one task with no worktree — `sddx task create --workspace
none`, the same primitive `--solo`/`/sddx:quick` drive inside Claude Code.
Every other example builds on this one.

## Setup

From the repo root:

```sh skip
bash examples/01-single-task/setup.sh
```

This prints a scratch directory with a local `./sddx` shim. `cd` there before
running anything below. Installed sddx globally instead (see
[install-sddx.md](../../docs/how-to/install-sddx.md))? Use plain `sddx`
throughout.

## Write the spec

```sh
cat > spec.yaml <<'EOF'
task: health check returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
EOF
```

## Register the task

```sh
OUT=$(./sddx task create --spec spec.yaml --workspace none)
echo "$OUT"
ID=$(echo "$OUT" | awk '{print $2}')
```

`task create` prints `created <id> phase=PLAN ...`; `$ID` carries the id
(`YYYYMMDD-<slug>`) into every command below.

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
./sddx task phase "$ID" RED --test-exit 1
```

`--test-exit` is checked, not trusted — a `0` here is refused. Now record
that the spec's own oracle (the same command) fails too, while the
implementation still doesn't exist — `sddx verify` later refuses without
this:

```sh
./sddx red-check "$ID"
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
./sddx task phase "$ID" GREEN --test-exit 0
```

## Verify

```sh
./sddx task phase "$ID" VERIFY
```

```sh
./sddx verify "$ID"
```

On success this writes `.sddx/receipts/$ID.json` and makes one atomic commit
containing `health.ts`, `tests/health.test.ts`, `spec.yaml`, and the receipt.

## Check the board and the chain

```sh
./sddx board
```

```sh
./sddx audit
```

`audit` re-walks the receipt chain and exits 0 on `chain intact`. See
[examples/07-receipts-and-audit](../07-receipts-and-audit/) for what happens
when it isn't.
