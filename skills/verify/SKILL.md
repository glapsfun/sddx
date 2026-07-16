---
name: verify
description: Execute a task's oracle and, on pass, produce the hash-chained receipt and atomic commit. Use when an sddx task reaches VERIFY or the user asks to verify a task.
---

# /sddx:verify

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Run: `... verify <task-id> --model <your model id, if you know it>`

- **pass** → the CLI has already written `.sddx/receipts/<id>.json` (immutable,
  chained to the previous receipt) and made one atomic commit containing code +
  spec + task file + receipt. Report the receipt path and commit SHA to the user.
- **fail** → the oracle's exit code and the attempt count are printed; the task
  stays in VERIFY. Return to the loop (fix under GREEN/REFACTOR rules), then
  verify again. Respect the spec's stop_rules: if iterations exceed
  max_iterations (default 5), stop and escalate to the user.

Never write or edit anything under `.sddx/receipts/` yourself. Never re-run
verify on a DONE task — receipts are write-once.
