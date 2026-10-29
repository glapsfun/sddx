# sddx in Codex

Paths in this file are relative to the folder that holds it.

| The skills say | In Codex |
| --- | --- |
| use the `<name>` skill | read that skill's `SKILL.md` from the skills list; the user can mention `$sddx:<name>` |
| ask the user a question | end your turn with one question |
| track the steps | `update_plan` |
| dispatch the worker for a task | `spawn_agent` with `fork_turns: "none"`, telling it to read and follow `../../../agents/worker.md`, with the task id, worktree path, spec section, Acceptance lines and the command to run sddx |
| dispatch the critic | the same, with `../../../agents/critic.md` and what the review skill gives it |
| dispatch workers in parallel | several `spawn_agent` calls, then `wait_agent` |
| `--harness <name>` | `--harness codex` |
| `--model <name>` | the model you are running as |

## Running sddx

Use the command session start gave you. If it gave none, the plugin's hooks
are not trusted yet: run `../../../bin/sddx` by its full path, and tell the user
to trust the sddx hooks in `/hooks`.

## The sandbox

Codex's sandbox keeps `.git` read-only, so these commands fail inside it:
`sddx plan start`, `sddx task start`, `sddx verify`, `sddx review record`,
`sddx task abandon`, `sddx cleanup`, `sddx sweep` and `sddx pr create`. Run them
with sandbox escalation and a one-line justification naming the gate; the user
can allow the sddx command once instead of approving each run.

## Approval

Only a person approves a plan: the hook and the CLI both refuse
`sddx plan approve` when you run it. Ask the user to review the plan and type
`!sddx plan approve <spec>`, with the full sddx path you were given. Under
`codex exec` nobody can type it: stop and hand the approval back.

## Subagents

Workers share the session's directory, so they start each shell command with
`cd <worktree> &&`, as their role file says. A Codex subagent keeps your
sandbox and write access, and its role file cannot take them away. If the
critic edits a file, `sddx review record` refuses the changed tree and the task
returns to `IN_PROGRESS`.
