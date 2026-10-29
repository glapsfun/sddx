---
name: review
description: Use when an sddx task is IN_REVIEW. Dispatches the critic on the verified diff in a clean context and records its verdict with sddx review record.
---

# Review

A passing oracle shows the change works. Review asks whether it is the right
change, done well. sddx records that a review happened, on exactly the diff
that was proven.

## Dispatch the critic

1. `sddx task show <id>` prints the task as JSON. Note `workspace.path` and,
   under `verified`, `base_sha` and `tree_sha`.
2. Dispatch the critic subagent with the task's section of the spec, the
   design's Acceptance lines, the worktree path, and the command for the
   proven diff: `git -C <path> diff <base_sha> <tree_sha>`.
3. The critic returns a verdict, pass or fail, and its findings.

Use a fresh critic for each review, never the worker that wrote the code.

## Record the verdict

Write the findings to a file outside the repository, then record:

- pass: `sddx review record <id> --verdict pass --reviewer sddx:critic --harness <name> --model <name>`,
  adding `--findings <file>` when the critic noted anything;
- fail: `sddx review record <id> --verdict fail --findings <file> --reviewer sddx:critic`.

A pass makes the task `DONE`: sddx commits the proven tree with its receipt
and merges it into the goal's run branch. The output reports the merge. If it
could not merge, it prints the command for doing so by hand; tell the user.

A fail returns the task to `IN_PROGRESS`. Use the execute skill with the
findings.

If `review record` says the tree changed since verify, someone edited the
worktree after the proof. Run `sddx verify <id>` again, then review again.
