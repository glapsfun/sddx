---
name: plan
description: Turn a development goal into a dense sddx spec — binary success criteria, a mandatory oracle, stop rules — and register it as a task. Use when the user wants to plan or spec out a task before executing it.
---

# /sddx:plan

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Read the interaction mode first — `.data.interaction_mode` from
`... config show --output json`. It decides whether this skill may ask
anything, and there is no flag or environment override.

1. **Hunt the gaps.** Interrogate the goal until nothing is vague: exact inputs
   and outputs, edge cases, what is explicitly out of scope, and — above all —
   the observable signal that proves success. Under `human`, ask the user in
   **one** round of at most three questions, each with why it matters and a
   recommended default. Under `auto`, ask nothing: resolve every open decision
   conservatively, record it with its rationale, and if one genuinely cannot be
   taken safely, say so and stop rather than guessing.
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
   on_dependency_failure: skip  # optional — skip (default) | block
   retry:                       # optional — bounded automatic retry before ABANDONED
     max_attempts: 1            # default 1 = no automatic retry, today's behavior
     workspace: fresh           # fresh (default) | reuse
   ```

   Declare `scope` when the task will run alongside others: it's the write-lane
   the graph gate checks for conflicts and the gate enforces at run time. A
   dependent task (one that needs another's committed result — possibly
   several, for a fan-in task) is expressed in the graph with `depends_on`,
   not in this spec — see `/sddx:run`. Leave `on_dependency_failure`/`retry`
   unset unless this task specifically needs to block on (rather than skip
   past) a failed ancestor, or needs more than one automatic attempt.

4. **Register it.** Save the YAML to `.sddx/drafts/<date>-<slug>.yaml` (dated
   so same-wording plans on different days never collide) and run:
   `... task create --spec .sddx/drafts/<date>-<slug>.yaml --workspace branch`
   (in-session flow; /sddx:run uses `--workspace auto` for worktrees instead).
   The CLI rejects any spec without a valid oracle — fix the spec, never work
   around the rejection. On success it prints the task id and switches to the
   `sddx/<id>` branch.
5. Hand off to /sddx:quick to execute.

## Plan only, run later

Planning and running are separate acts. To produce a multi-task plan **without
materializing it**, draft the graph as /sddx:run does — the Goal Brief header
plus one spec per node under `.sddx/drafts/` — and stop before `graph create`.

- Under `human`: render the plan with
  `... graph create --graph <path> --dry-run`, which writes nothing, and relay
  it. If the user approves, `... graph approve --graph <path>` records a token
  and **still creates nothing**. A later `/sddx:run` over the *unchanged* draft
  finds that token and proceeds without asking again — approval is
  content-addressed by plan hash, not bound to one session.
- Under `auto`: produce the plan, render it for the record, and stop. Ask
  nothing and wait for nothing. Do not write an approval token — an auto run is
  authorized by its mode, and a token would record a human approval that never
  happened.

Any edit to the draft after approval — including to an answer or an assumption
in the header — changes the plan hash and invalidates the token. That is the
mechanism working: the approval was over the plan the user actually read.

To discard a drafted plan: `... graph regenerate --graph <path>` keeps the Goal
Brief and drops the decomposition; `... graph cancel --graph <path>` removes the
drafts entirely. Neither leaves a branch, worktree, task, or goal behind,
because none was ever created.
