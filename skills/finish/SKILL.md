---
name: finish
description: Use when every task of an sddx goal is DONE. Checks the run report and the receipt chain, then opens a pull request from the goal's run branch for a person to merge.
---

# Finish

1. `sddx run report --goal <goal-id>` shows what merged into the run branch
   and what was skipped or failed. Tell the user about every task that did not
   merge, and why.
2. Audit the receipt chain where the goal's receipts are. A passing review
   commits each receipt to the run branch, `sddx/run-<goal-id>`, not to this
   checkout, so audit a temporary checkout of that branch:

   ```sh
   run="$(mktemp -d)/run"
   git worktree add --detach "$run" sddx/run-<goal-id>
   (cd "$run" && sddx audit)
   git worktree remove "$run"
   ```

   It must report every merged task's receipt verified and the chain intact.
3. `sddx pr create --goal <goal-id>` pushes the run branch and opens a pull
   request from it. Give the user the link.

A person reviews and merges the pull request into the target branch. Never
merge it yourself.

Once it is merged, `sddx cleanup <id>` removes a finished task's worktree, and
`sddx sweep` removes orphaned ones.
