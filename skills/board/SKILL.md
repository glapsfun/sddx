---
name: board
description: Regenerate .sddx/BOARD.md and show task status across the repo and its worktrees. Use when the user asks for sddx status, the board, or task progress.
---

# /sddx:board

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Run: `... board`

The command regenerates `.sddx/BOARD.md` deterministically from the task and
receipt files (workspace plus in-flight worktrees) and prints the path —
`(unchanged)` means the board was already current. Read the file and present
the table to the user; call out rows in UNREADABLE state and any non-empty
Allow column (those are audited TDD-gate exemptions worth a second look).

Never edit `.sddx/BOARD.md` by hand — it is generated, and the next session
start overwrites it.
