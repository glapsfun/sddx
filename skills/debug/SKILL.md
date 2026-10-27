---
name: debug
description: Use when sddx verify fails and the cause is not obvious, or sddx board flags a task as stuck. Reproduces with the oracle, tests one hypothesis at a time, and pins the bug with a failing test.
---

# Debug

Find the cause before changing anything.

1. **Reproduce.** Run the task's oracle command in its worktree and read the
   whole output. `sddx task show <id>` has the oracle and the worktree path.
2. **Locate the half.** If verify failed its RED half, the oracle passed on the
   base with only the task's tests applied: the tests do not catch the change.
   Strengthen them; do not touch the oracle. If it failed its GREEN half, the
   change itself is wrong or incomplete.
3. **One hypothesis at a time.** State it, make the smallest change that tests
   it, and run the oracle again. Undo a change that did not help before trying
   the next.
4. **Pin it.** Once you know the cause, write a test that fails because of it,
   then fix the code until the test passes.
5. **Prove it.** `sddx verify <id>`.

If the task is stuck, with the same failure several times, stop and tell the
user what you tried and what you learned. The fix may belong in the spec:
a wrong oracle or scope means revising the spec and approving it again, or
abandoning the task with `sddx task abandon <id> --reason "<why>"`.
