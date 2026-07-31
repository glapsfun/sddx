---
name: verify
description: Execute a task's oracle and, on pass, produce the hash-chained receipt and atomic commit. Use when an sddx task reaches VERIFY or the user asks to verify a task.
---

# /sddx:verify

CLI: `{{SDDX}}` (run from the repo root).

Run: `... verify <task-id> --model <your model id, if you know it>`

- **pass** → the CLI has already written `.sddx/receipts/<id>.json` (immutable,
  chained to the previous receipt) and made one atomic commit containing code +
  spec + task file + receipt. If the task belongs to a goal, the same command
  also merged it into that goal's run branch automatically — report that
  integration line too (merged, or a conflict needing manual resolution).
  Report the receipt path, the commit SHA, and the integration line — then
  stop. Do NOT offer a menu of next actions here. The handoff is goal-scoped
  and belongs to the run: it is shown once, after the run summary, by
  `... next-actions --goal <goal-id>`. A per-task menu offered actions before
  the run reached that single handoff point, and offered them against whatever
  branch the verifier happened to be sitting on.
- **fail** → the oracle's exit code and the attempt count are printed; the task
  stays in VERIFY. Return to the loop (fix under GREEN/REFACTOR rules), then
  verify again. Respect the spec's stop_rules: if iterations exceed
  max_iterations (default 5), stop and escalate to the user.
- **error: no failing-oracle evidence** → the red-check was skipped. A task
  still in RED can run `... red-check <id>`; a task already past RED cannot be
  red-checked retroactively — abandon and recreate it. Escalate to the user.

After a pass, cross-check the spec's `success_criteria` in prose: list each
criterion and whether the oracle's observed run covers it. This review is
non-binding — the receipt verdict derives solely from the oracle exit code,
and a prose doubt can neither pass nor fail a task. If a criterion turns out
not to be exercised by the oracle, report it to the user as a spec gap: the
fix is a better oracle in a future spec, never a hand-judged verdict.

Never write or edit anything under `.sddx/receipts/` yourself. Never re-run
verify on a DONE task — receipts are write-once.
