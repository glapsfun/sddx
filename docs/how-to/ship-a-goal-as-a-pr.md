# Ship a goal as a PR

`sddx pr create --goal <goal-id>` opens **one PR per goal**: every task in
the goal cherry-picked onto a single branch, with a body generated from the
tasks' receipts. It's a deliberately separate, explicitly-invoked command —
`/sddx:run` never calls it automatically, the same way it never merges
branches automatically. The two refusal paths below are fully local and
network-free — a full runnable proof is
[examples/08-pr-from-goal](../../examples/08-pr-from-goal/).

## All-or-nothing

Refuses unless every task in the goal is `DONE` with a passing receipt,
re-checked fresh at invocation time — not cached from when the goal was
created:

```
goal <id> is not complete — blocking: <task-id> (phase <phase>)
```

## Resolving the host

`pr_host` (userConfig — see [config.md](../reference/config.md)) picks `gh`
or `glab` explicitly; unset, it's detected from the `origin` remote
(`github.com` → `gh`, `gitlab.com` → `glab`). Neither configured nor
detectable refuses before touching git:

```
cannot determine PR host from the "origin" remote — set userConfig.pr_host to "gh" or "glab"
```

An unauthenticated host CLI refuses the same way, one step later (after the
host is resolved, before any push): `<host> is not authenticated: <message>`.

## What happens on success

Cherry-picks each task's atomic commit onto a fresh `sddx/goal-<goal-id>`
branch (task-creation order, never a merge commit), pushes it, and opens the
PR (or, on GitLab, the merge request — same command name, same mechanics,
only the host object's name differs) via the resolved host CLI. On success,
writes a `shipped` marker onto every task's branch and the goal file — the
second, equally valid proof `sddx cleanup` accepts for a task branch that
will never look git-merged by ancestry, since its commit was cherry-picked,
not merged.

A cherry-pick conflict refuses loudly too, naming the task whose commit
failed — no partial branch is left pushed.
