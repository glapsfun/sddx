# Ship a goal as a PR

`sddx pr create --goal <goal-id>` pushes the goal's run branch, which collects
each task as its review passes, and opens one pull request (or GitLab merge
request) from it. The body is generated from the receipts of the tasks that have
merged. The finish skill runs it once every task is `DONE`; nothing ships, and
nothing is merged into your branch, unless someone runs it. The refusal paths
below are local and need no network; a runnable proof is
[examples/08-pr-from-goal](../../examples/08-pr-from-goal/).

## Partial goals are fine

There is no completeness gate. A goal with 2 of 3 tasks merged ships a pull
request with exactly those 2 tasks' work, and the body states the outstanding
count instead of implying the goal finished. Check where things stand first:

```sh
sddx run report --goal <goal-id>
```

It lists what merged, what was skipped, failed or blocked, a diff summary, and
the commands to review the run branch yourself.

## Resolving the host

The `pr_host` key in `.sddx/config.json` picks `gh` or `glab` explicitly. When
it is unset, sddx reads the host from the `origin` remote (`github.com` means
`gh`, `gitlab.com` means `glab`). If neither works, `pr create` refuses before
touching git and asks you to set `pr_host`. An unauthenticated host CLI is
refused the same way, before any push. Running `pr create` again for a goal
that already shipped refuses and names the existing pull request instead of
opening a second one.

## What happens on success

sddx pushes `sddx/run-<goal-id>` as it stands: every commit on it is a task's
own commit or a `git merge --no-ff` that a passing review made. It opens the
pull request through the host CLI and records the URL on the goal.

Merging the pull request is your decision. Afterwards, `sddx cleanup <id>`
removes a finished task's worktree, and `sddx sweep` removes any left behind.
