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
   scope:             # optional — write globs this task's lane covers
     - "<glob>"
   oracle:            # mandatory — no oracle, no goal
     type: command    # command | test-suite | browser | manual
     run: "<command that proves success>"
     expect: exit 0
   stop_rules:
     - max_iterations: 5
   out_of_scope:
     - "<explicitly not doing>"
   ```

   Declare `scope` when the task will run alongside others: it's the write-lane
   the graph gate checks for conflicts and the gate enforces at run time. A
   dependent task (one that needs another's committed result) is expressed in
   the graph with `depends_on`, not in this spec — see `/sddx:run`.

4. **Register it.** Save the YAML to `.sddx/drafts/<date>-<slug>.yaml` (dated
   so same-wording plans on different days never collide) and run:
   `... task create --spec .sddx/drafts/<date>-<slug>.yaml --workspace branch`
   (in-session flow; /sddx:run uses `--workspace auto` for worktrees instead).
   The CLI rejects any spec without a valid oracle — fix the spec, never work
   around the rejection. On success it prints the task id and switches to the
   `sddx/<id>` branch.
5. Hand off to /sddx:quick to execute.
