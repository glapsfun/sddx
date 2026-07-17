---
name: quick
description: Run a single sddx task through the PLAN → RED → GREEN → REFACTOR → VERIFY loop. Use when the user asks to execute one small, well-scoped task with spec-driven TDD.
---

# /sddx:quick

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

No task yet? Follow /sddx:plan first — `task create --workspace branch`
registers the spec and
switches to the `sddx/<id>` branch.

Then loop, recording every phase in the task file:

1. **RED** — write the failing test FIRST. No implementation code of any kind.
   Run the test runner and capture its exit code, then:
   `... task phase <id> RED --test-exit <code>`
   (rejected unless the code is nonzero — a passing test is not RED).
2. **GREEN** — write the minimal implementation. Re-run the tests; when they
   pass: `... task phase <id> GREEN --test-exit 0`.
3. **REFACTOR** (optional) — clean up; tests must stay green.
4. `... task phase <id> VERIFY`, then follow /sddx:verify.

Rules:
- Phase transitions demand evidence (test exit codes); never claim a phase.
- Check `iterations` in `.sddx/tasks/<id>.json` against the spec's
  max_iterations (default 5) each verify attempt; exceeded → stop, escalate.
- Never touch `.sddx/receipts/**`. DONE is the verifier's call, not yours.
- After DONE the work sits on `sddx/<id>`; offer the user the merge — never
  merge or clean up without being asked. Cleanup: `... cleanup <id>` (deletes
  only merged branches).
