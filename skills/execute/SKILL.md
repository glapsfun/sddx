---
name: execute
description: Use when an sddx goal has tasks ready to implement. Starts each ready task, dispatches one worker per task in its own worktree, and ends every task at sddx verify.
---

# Execute

Get each ready task from `PLANNED` to a passing boundary proof.

## Start the ready tasks

1. `sddx task ready --goal <goal-id>` lists the tasks whose dependencies are
   done.
2. `sddx task start <id>` for each one. It creates the task's worktree under
   `.sddx-worktrees/<id>` on branch `sddx/<id>`, and prints its path.

Tasks that are ready together have disjoint scopes (`plan check` made sure), so
their workers can run in parallel.

## Dispatch one worker per task

Dispatch the worker subagent for each started task. Give it:

- the task id and its worktree path;
- the task's section of the spec: title, oracle and scope;
- the Acceptance lines its oracle proves;
- the command to run sddx.

The worker writes a failing test first, then the code, and finishes with
`sddx verify <id>`. All work stays inside the worktree. Nobody edits the main
checkout for a task in progress.

## Read the outcome

- **Verify passed:** the task is `IN_REVIEW`. Use the review skill.
- **Verify failed:** its message names the half that failed. A failing RED
  half means the tests pass without the change, so they do not catch it: the
  test needs strengthening, not the oracle. A failing GREEN half means the
  change is not done. Send the worker back with the message.
- **The same failure twice, or `sddx board` flags the task stuck:** use the
  debug skill.
- **The task cannot be done as specified:** tell the user. With their
  agreement, `sddx task abandon <id> --reason "<why>"`. Dependent tasks are
  then skipped, or the goal halts, as the spec's `on_dependency_failure` says.

`verify` refuses changes under `.sddx/` and implementation changes outside the
task's scope, and compares the oracle and scope with the approved spec. Changing either means
changing the spec and approving it again.

## The strict profile

When `sddx config show` reports `profile: strict`, hooks block implementation
writes until a failing test run is recorded for the task. The worker runs the
new failing test first; the recorder notes the RED run. For a test runner the
recorder does not know, record runs by hand with
`sddx task phase <id> RED --test-exit 1` and, once it passes,
`sddx task phase <id> GREEN --test-exit 0`. A file that cannot be test-driven,
such as generated code, needs the user's consent for
`sddx task allow <id> <path>`, and is never allowed in `auto` mode.
