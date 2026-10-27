# Getting started: your first goal

This tutorial takes one small goal from an empty repository to a pull request,
in a Claude Code session with the sddx plugin. Where Codex differs, a note at
the end of the step says how. At each step you will see what
the agent does and the sddx command that gates it. The same lifecycle driven by
hand from the CLI, with no agent at all, is the runnable scaffold at
[examples/01-single-task](../../examples/01-single-task/).

## Before you start

Install Bun and the plugin (details in [Install sddx](../how-to/install-sddx.md)):

```sh
curl -fsSL https://bun.sh/install | bash
```

```
/plugin marketplace add glapsfun/sddx
/plugin install sddx@sddx
```

> **In Codex:** install with `codex plugin marketplace add glapsfun/sddx` and
> `codex plugin add sddx@sddx`, then open `/hooks` and trust the sddx hooks.

Then make a repository with one commit and a test runner. This tutorial uses
Bun's:

```sh
mkdir greeter && cd greeter && git init
bun init -y
git add -A && git commit -m init
```

Start Claude Code there. The repository has no `.sddx/` yet, so session start
adds a single line: sddx is installed, and `/sddx:brainstorm` plans a change
with it. Nothing else about the session changes until you opt in.

## 1. Brainstorm the design

Type:

```
/sddx:brainstorm add a greet(name) function that returns "Hello, <name>"
```

> **In Codex:** mention `$sddx:brainstorm` instead.

The agent asks one question at a time, for example what an empty name should
return, and you can answer "skip" to let it decide. Then it writes the design
into `.sddx/specs/<date>-greeting.md`:

```markdown
# Greeting

## Design

### Goal
Greet a person by name.

### Acceptance
- greet("Ada") returns "Hello, Ada"
- greet("") returns "Hello, stranger"

### Non-goals
- localized greetings

### Assumptions
- an empty name gets the stranger greeting, decided without asking

### Open decisions
```

Every Acceptance line must be provable by a command, and Open decisions must be
empty. The agent closes the step with:

```sh
sddx spec check .sddx/specs/2026-10-27-greeting.md
```

`.sddx/` now exists, so the repository is opted in. Every new session here
starts with the sddx router and a list of unfinished tasks.

## 2. Plan and approve

The plan skill appends `## Tasks`, one task per independently provable piece.
Here one is enough:

````markdown
## Tasks

### greet-1 greet function

```sddx
oracle:
  type: command
  run: bun test tests/greet.test.ts
  expect: exit 0
scope: [src/greet.ts, tests/greet.test.ts]
```
````

The agent commits the spec, then runs the three plan gates:

```sh
sddx plan check .sddx/specs/2026-10-27-greeting.md
sddx plan approve .sddx/specs/2026-10-27-greeting.md --harness claude-code
sddx plan start .sddx/specs/2026-10-27-greeting.md
```

`plan approve` raises Claude Code's permission dialog, naming the plan's hash.
**That dialog is your approval.** Read the plan before you accept: the agent
cannot answer it for you, and the approval covers exactly these bytes. Change
the spec afterwards and the hash no longer matches, so `plan start` refuses.

`plan start` creates the goal, its run branch `sddx/run-2026-10-27-greeting`,
and the task `greet-1` in state `PLANNED`.

> **In Codex:** there is no dialog. The agent stops and asks you to type the
> approve command yourself, with Codex's `!` prefix and the full path session
> start gave; typing it is your approval. The agent passes `--harness codex`.

## 3. Execute

```sh
sddx task start greet-1
```

This creates the task's worktree at `.sddx-worktrees/greet-1` on branch
`sddx/greet-1`. Your own checkout is never touched. A worker subagent writes
`tests/greet.test.ts`, watches it fail, writes `src/greet.ts`, and finishes
with:

```sh
sddx verify greet-1
```

`verify` is the boundary proof. It runs the oracle twice in a scratch worktree:
on the base commit with only the task's test files applied, where it must
**fail**, and on the finished tree, where it must **pass**. A test that passes
without the change proves nothing, so `verify` refuses it. A pass moves the
task to `IN_REVIEW`. [Verification](../reference/verification.md) has the
details.

> **In Codex:** the agent starts the worker from the plugin's role file, and
> asks to run `task start` and `verify` outside Codex's sandbox, which keeps
> `.git` read-only. Approve the request.

## 4. Review

A critic subagent, in a clean context and with no file-editing tools, reviews
exactly the proven diff against the spec. The agent records its verdict:

```sh
sddx review record greet-1 --verdict pass --reviewer sddx:critic --harness claude-code
```

A pass makes the task `DONE`. sddx commits the proven tree together with the
task state and a receipt, `.sddx/receipts/greet-1.json`, and merges that commit
into the run branch. A fail sends the task back to the worker with the
critic's findings.

> **In Codex:** the critic keeps write access, but an edit would change the
> proven tree, and `review record` would refuse the review.

## 5. Finish

```sh
sddx run report --goal 2026-10-27-greeting
sddx pr create --goal 2026-10-27-greeting
```

The run report shows every task merged, and `pr create` opens a pull request
from the run branch. In between, the agent runs `sddx audit` in a temporary
checkout of the run branch, where the receipts were committed, to check the
chain before it ships. Merging the pull request into your branch is your
decision; sddx never does it.

## Where to look

- `sddx board` shows every task and its state.
- [Receipts schema](../reference/receipts-schema.md) explains what a receipt
  proves and what `audit` checks.
- [Hooks and the plugin](../reference/hooks.md) lists what the plugin
  registers and what session start says.

Next: [your first parallel run](02-your-first-parallel-run.md), the same
lifecycle with tasks that run side by side.
