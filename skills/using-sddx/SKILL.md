---
name: using-sddx
description: Use at the start of work in a repository with .sddx/, or when the user asks to build or change something with sddx. Routes the work through brainstorm, plan, execute, review and finish, each ending at an sddx CLI gate.
---

# Using sddx

sddx is the gate and the manager, not the coder. You write code your usual
way; the `sddx` CLI decides when work may start, proves each change with its
oracle, and records the review. Every guarantee is enforced by the CLI and git.
These skills tell you which gate comes next.

## When to route work through sddx

In a repository with `.sddx/`, route every change to behavior through a goal:
a feature, a bug fix, a refactor that changes what code does. Answering
questions, reading code and running commands need no goal. If the user says to
skip sddx for a request, do it directly and say that it will leave no receipt.

## The flow

| Step | Skill | Done when |
| --- | --- | --- |
| idea to design | brainstorm | `sddx spec check <spec>` reports the spec ready |
| design to tasks | plan | `sddx plan start <spec>` has created the tasks |
| task to proven change | execute | `sddx verify <id>` passes |
| proven change to reviewed | review | `sddx review record <id> --verdict pass` |
| every task done | finish | `sddx pr create --goal <goal-id>` opened the PR |
| a failure you cannot explain | debug | `sddx verify <id>` passes |

No spec yet: start with brainstorm. A spec with a ready design and no
`## Tasks`: plan. A started goal: `sddx next-actions --goal <goal-id>` names
the next step.

## Where things stand

- `sddx board`: every task and its state.
- `sddx goal show <goal-id>` and `sddx task show <id>`: one goal or task.
- `sddx run report --goal <goal-id>`: what merged, what was skipped or failed.

## Rules

- Run sddx with the command the session context gave you. It is plain `sddx`
  unless another sddx shadows the plugin's on PATH.
- Never write `.sddx/tasks/`, `.sddx/approvals/`, `.sddx/config.json` or
  `.sddx/receipts/` by hand. The CLI owns them, and the approval gate refuses
  writes to approvals and config.
- Never approve a plan for the user. `sddx plan approve` raises the user's own
  permission dialog, and their answer is the approval.
- A task is done only when `sddx review record` has passed it. Do not claim
  done before that.
- When a command refuses, read its message: it names the fix. Do not work
  around a gate.
- Tool names in these skills are generic: dispatch a subagent, ask the user,
  track the steps. The mapping for your harness says which tool does each:
  `references/claude-code.md` or `references/codex.md`, beside this file.
  Session start usually includes it already.
