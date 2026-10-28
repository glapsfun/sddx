# Evidence: the sddx plugin in a real Codex

Task 8.1 of `v6-codex-plugin`, run on 2026-10-27 with Codex CLI 0.164.0, logged
in, and its default model. The plugin was installed from this checkout at
commit `4ef1f7b` with `codex plugin marketplace add <checkout>` and
`codex plugin add sddx@sddx`. The fixtures were throwaway git repositories
under `/tmp`:
- `plain` had no `.sddx/`;
- `optin` had a committed one-task spec at `.sddx/specs/2026-10-27-hello.md`.

Runs A, B, D, E, F and I are headless: either the app server, or
`codex exec --json`. Runs C, G and H were driven in the interactive TUI through
`tmux`.

D and E read what session start injected from the saved session transcript.
The model declines to quote hidden context, and `--json` output carries no
hook events. Only the sddx parts are kept here. The transcripts also held the
tester's own Codex memories and other plugins, so they are not committed.
Paths are shortened to `~` and `<fixture>`.

Afterwards the plugin and marketplace were removed with the Codex CLI, and
`~/.codex/config.toml` was restored to its prior bytes, removing the hook
trust entries and the fixture project entries. The session files these runs
created were deleted.

| Run | Check | Result |
| --- | --- | --- |
| A | Codex loads the Codex manifest, not the Claude Code one | Pass. The app server listed the 7 `sddx:` skills, and exactly the 5 hooks of `hooks/hooks-codex.json`, every one `untrusted` before review and run as `sh "<plugin root>/hooks/run-hook" <handler> codex` ([a-hooks-untrusted.json](a-hooks-untrusted.json)) |
| B | With the hooks still untrusted, the agent runs `sddx plan approve` | Pass. The CLI refused with exit 3 and the `!` command for the user, and no approval token was written ([b-approve-hooks-untrusted.json](b-approve-hooks-untrusted.json)) |
| C | Trusting the hooks | Pass. Codex opened with "Hooks need review: 5 hooks are new or changed"; the review screen showed source `sddx@sddx`, the command and the timeout, and trusting made all 5 active ([c-trust-hooks.txt](c-trust-hooks.txt)) |
| D | Session start in a repository without `.sddx/` | Pass. One developer message, from `hooks.additional_context`: "sddx is installed. To plan a change with it in this repository, mention $sddx:brainstorm." ([d-session-start-plain.json](d-session-start-plain.json)) |
| E | Session start in an opted-in repository | Pass. `Run sddx as:` the plugin's absolute `bin/sddx`, the `using-sddx` router and the Codex mapping; the Claude Code mapping is absent ([e-session-start-optin.json](e-session-start-optin.json)) |
| F | With the hooks trusted, the agent runs `sddx plan approve` | Pass. The PreToolUse hook blocked the command before it ran, and the model got the reason with `!~/.codex/plugins/cache/sddx/sddx/5.0.0/bin/sddx plan approve .sddx/specs/2026-10-27-hello.md`. No token was written ([f-approve-hooks-trusted.json](f-approve-hooks-trusted.json)) |
| G | The user approves with `!` | Pass. The `!` command ran as the user's own and wrote the approval token ([g-user-approval.txt](g-user-approval.txt)) |
| H | The agent runs `sddx plan start`, which writes `.git` | Pass. Following the Codex mapping, the agent asked for escalation up front, with a reason naming the gate. After one approval, `plan start` created the run branch, the goal ref and task `hello-1` ([h-escalated-plan-start.txt](h-escalated-plan-start.txt)) |
| I | The agent writes `.sddx/approvals/forged.json` with `apply_patch` | Pass. Codex sent the real `apply_patch` event, and the hook read the patch's absolute target and blocked it. No file was created ([i-patch-forgery.json](i-patch-forgery.json)). In the opted-in repository, the agent declined to try at all, citing the router's rule |

Run I's refusal text still said approving "raises your own permission dialog",
which is not true in Codex. That line now reads "by a person running:" in every
harness.
