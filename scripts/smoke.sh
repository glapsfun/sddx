#!/bin/sh
# End-to-end smoke test of whatever `sddx` is first on PATH: the packed release
# candidate in CI, the source tree in tests/smoke.test.ts. One goal goes through
# the whole v6 lifecycle in a throwaway repository, including the check that
# verify refuses work whose tests do not yet pass.
set -eu

demo="$(mktemp -d)"
cd "$demo"
git init -q -b main .
git config user.email smoke-test@example.com
git config user.name smoke-test
git config commit.gpgsign false
git commit --allow-empty -q -m init

spec=.sddx/specs/2026-01-01-smoke.md
mkdir -p .sddx/specs
cat > "$spec" <<'SPEC'
# Smoke

## Design

### Goal
A health function reports ok.

### Acceptance
- health() returns "ok"

### Non-goals

### Assumptions

### Open decisions

## Tasks

### h-1 Health function

```sddx
oracle:
  type: command
  run: bun test tests/health.test.ts
  expect: exit 0
scope: [src/health.ts]
```
SPEC
git add "$spec"
git commit -q -m "plan: smoke"

sddx --version
sddx spec check "$spec"
sddx plan check "$spec"
sddx plan approve "$spec"
sddx plan start "$spec"
sddx task start h-1

wt="$demo/.sddx-worktrees/h-1"
mkdir -p "$wt/tests" "$wt/src"
cat > "$wt/tests/health.test.ts" <<'TEST'
import { expect, test } from "bun:test";
import { health } from "../src/health";
test("health", () => expect(health()).toBe("ok"));
TEST

if sddx verify h-1; then
  echo "smoke: verify passed before the implementation existed" >&2
  exit 1
fi

cat > "$wt/src/health.ts" <<'IMPL'
export const health = (): string => "ok";
IMPL
sddx verify h-1
sddx review record h-1 --verdict pass --reviewer smoke

git merge -q --no-ff -m "merge smoke run" sddx/run-2026-01-01-smoke
sddx board
sddx audit
sddx doctor
echo "smoke: ok"
