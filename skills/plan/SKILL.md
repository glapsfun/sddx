---
name: plan
description: Turn a development goal into a dense sddx spec — binary success criteria, a mandatory oracle, stop rules — and register it as a task. Use when the user wants to plan or spec out a task before executing it.
---

# /sddx:plan

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

1. **Hunt the gaps.** Interrogate the goal until nothing is vague: exact inputs
   and outputs, edge cases, what is explicitly out of scope, and — above all —
   the observable signal that proves success. Ask the user; do not guess.
2. **Every criterion binary.** Rewrite each success criterion until it is
   pass/fail with no judgment call. "Fast" is not a criterion; "p95 < 100ms in
   bench output" is.
3. **Draft the spec** (YAML, this shape):

   ```yaml
   task: <one sentence>
   context: <links/paths, not prose>
   success_criteria:
     - "<binary check>"
   oracle:            # mandatory — no oracle, no goal
     type: command    # command | test-suite | browser | manual
     run: "<command that proves success>"
     expect: exit 0
   stop_rules:
     - max_iterations: 5
   out_of_scope:
     - "<explicitly not doing>"
   ```

4. **Register it.** Save the YAML to a file and run:
   `... task create --spec <file>`
   The CLI rejects any spec without a valid oracle — fix the spec, never work
   around the rejection. On success it prints the task id and switches to the
   `sddx/<id>` branch.
5. Hand off to /sddx:quick to execute.
