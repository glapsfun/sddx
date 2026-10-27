# Evidence: the sddx plugin in a real Claude Code

Task 6.1 of `v6-claude-plugin`, run on 2026-10-27 with Claude Code 2.1.311 and
model Haiku 5.5. The plugin was loaded from this checkout with
`claude --plugin-dir <checkout>`, after rebuilding `dist/` with Bun 1.3.12. The
fixture repositories were throwaway git repositories under `/tmp`.

Runs A to C are headless (`claude -p --output-format stream-json
--include-hook-events`). Run D is an interactive session driven in `tmux`. The
JSON files keep only the sddx-related parts of each transcript: the plugin
entry, its skills and agents, the sddx hook outputs, tool calls and results,
and the final reply. The raw transcripts also listed every other plugin and
service on the machine, so they are not committed.

| Run | Check | Result |
| --- | --- | --- |
| A | Repository without `.sddx/`: session start says only that sddx is available | Pass. The plugin loaded as `sddx` with the 7 `sddx:` skills and both agents. Session start injected exactly the one line naming `/sddx:brainstorm` ([a-not-opted-in.json](a-not-opted-in.json)) |
| B | Opted-in repository: the router and unfinished tasks are injected; `sddx` in the agent's shell is the plugin's | Pass. Session start injected `Run sddx as: sddx`, both unfinished tasks and the router with its Claude Code mapping. In the agent's shell `sddx --version` printed `5.0.0` and `command -v sddx` resolved to the plugin's `bin/sddx` ([b-opted-in.json](b-opted-in.json)) |
| C | `sddx plan approve` under `claude -p` | Pass. The approval-gate hook returned `ask` with the plan hash; with no one to answer, Claude Code refused the command even though an allow rule matched it. The agent stopped and handed the approval back to the user. No approval token was written ([c-approval-headless.json](c-approval-headless.json)) |
| D | `sddx plan approve` in an interactive session, in auto-accept-edits mode | Pass. Claude Code showed the permission dialog raised by the plugin's `PreToolUse:Bash` hook, naming the plan hash and the review command ([d-approval-dialog-interactive.txt](d-approval-dialog-interactive.txt)). The dialog was declined, and no approval token was written |
| E | `s'ddx' plan approve .s'ddx'/specs/...` under `claude -p`, with every Bash command allowed | Pass, after the review fix to the launcher's pre-filter. The spelling joins into `sddx` only once the shell runs it, and the first launcher, matching the raw event text, let it through with no dialog. Now the approval-gate hook returned `ask` with the plan hash, Claude Code refused the command, and no approval token was written ([e-approval-split-spelling.json](e-approval-split-spelling.json)) |
