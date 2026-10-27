# sddx in Claude Code

| The skills say | In Claude Code |
| --- | --- |
| use the `<name>` skill | the Skill tool with `sddx:<name>`; the user can type `/sddx:<name>` |
| ask the user a question | AskUserQuestion, one question per call |
| track the steps | TodoWrite |
| dispatch the worker for a task | the Agent tool with `subagent_type: "sddx:worker"` |
| dispatch the critic | the Agent tool with `subagent_type: "sddx:critic"` |
| dispatch workers in parallel | several Agent tool calls in one message |
| `--harness <name>` | `claude-code` |
| `--model <name>` | the model id you are running as |

`sddx plan approve` raises Claude Code's permission dialog through the plugin's
approval gate, even in auto-accept mode. Under `claude -p` there is no dialog
and the command is refused: stop, and ask the user to run
`sddx plan approve <spec>` themselves, for example as `! sddx plan approve <spec>`
in an interactive session.
