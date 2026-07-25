# Ship a goal as a PR

`sddx pr create --goal <goal-id>` pushes that goal's **run branch** —
already continuously merged into as each task passes its oracle (see
[architecture.md](../explanation/architecture.md#state-model)) — and opens
one PR/MR from it, with a body generated from the receipts of whichever
tasks have actually merged. It's a deliberately separate, explicitly-invoked
command — `/sddx:run` never calls it automatically, the same way it never
merges into the *original target branch* automatically. The refusal path
below is fully local and network-free — a full runnable proof is
[examples/08-pr-from-goal](../../examples/08-pr-from-goal/).

## Partial goals are fine

There's no completeness gate. A goal with 2 of 3 tasks merged into its run
branch ships a PR containing exactly those 2 tasks' work — the body states
the outstanding count rather than implying the goal finished:

```
1 of 2 task(s) merged into `sddx/run-<goal-id>` — 1 outstanding.
```

Check where things stand at any point with `sddx run report --goal <goal-id>`
— merged/failed/outstanding counts, a diff summary, and the exact commands to
review the run branch yourself.

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
Re-running `pr create` on an already-shipped goal refuses too, naming the
existing PR URL, rather than opening a duplicate.

## What happens on success

Pushes `sddx/run-<goal-id>` exactly as it stands — no reconstruction, no
cherry-picking, since every commit on it is either a task's own atomic commit
or a real `git merge --no-ff` that `sddx verify` already made — and opens the
PR (or, on GitLab, the merge request — same command name, same mechanics,
only the host object's name differs) via the resolved host CLI. On success,
writes `shipped: {pr_url, at}` onto the goal file.

Once shipped, `sddx cleanup <id>` accepts a merged task's branch even though
it was never merged into your own `HEAD` — it checks whether the goal's
`merges` log currently records that task as `merged` (real bookkeeping sddx
itself wrote, not a self-reported marker, and revert-aware: a task whose
merge was later reverted no longer counts).
