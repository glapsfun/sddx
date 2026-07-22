---
name: quick
description: Run a single sddx task through the PLAN → RED → GREEN → REFACTOR → VERIFY loop. Use when the user asks to execute one small, well-scoped task with spec-driven TDD.
---

# /sddx:quick

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

No task yet? Follow /sddx:plan first — `task create --workspace branch`
registers the spec and
switches to the `sddx/<id>` branch.

Run `... config show --json` once and keep `agent_model` around: this loop
runs solo (no subagent dispatch), so it has no per-role model to override —
`agent_model` only matters if a step here ever hands off to a dispatched
agent (e.g. via `/sddx:plan`'s planner). Advisory only, not hook-enforced.

Then loop, recording every phase in the task file:

1. **RED** — write the failing test FIRST. No implementation code of any kind.
   Run the test runner and capture its exit code, then:
   `... task phase <id> RED --test-exit <code>`
   (rejected unless the code is nonzero — a passing test is not RED).
2. **Red-check** — `... red-check <id>` runs the spec's oracle and must see it
   fail. Exit 0 means the oracle cannot discriminate — fix the spec before any
   implementation; verify refuses a task without this record.
3. **GREEN** — write the minimal implementation. Re-run the tests; when they
   pass: `... task phase <id> GREEN --test-exit 0`.
4. **REFACTOR** (optional) — clean up; tests must stay green.
5. `... task phase <id> VERIFY`, then follow /sddx:verify.

Rules:
- Phase transitions demand evidence (test exit codes); never claim a phase.
- Check `iterations` in `.sddx/tasks/<id>.json` against the spec's
  max_iterations (default 5) each verify attempt; exceeded → stop, escalate.
- Never touch `.sddx/receipts/**`. DONE is the verifier's call, not yours.
- After DONE (or whenever the loop pauses for input), run `... next-actions`
  and relay its output verbatim as the completion message — don't compose
  your own summary of what's next. On the user's reply, run
  `... next-actions --select "<reply>"` and relay that output too. Cleanup:
  `... cleanup <id>` (deletes only merged branches).
