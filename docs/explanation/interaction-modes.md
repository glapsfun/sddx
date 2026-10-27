# Interaction modes: human-in-the-loop and unattended

sddx has two interaction modes. They are **not** two workflows: there is one
lifecycle, one receipt format, one run report. They differ only in whether a
person must approve the plan before anything is created.

```
 idea ─► brainstorm ─► spec ─► plan ──[G1]──► execute ─► verify ─► review ─► run branch ──[G2]──► your branch
                                        │                                                 │
                              human: you approve                                 always you,
                              auto:  self-approved                               in both modes
                                     unless a bound trips
```

`auto` is `human` with G1 pre-satisfied. That is how the code works, which is
why "the plan exceeded its blast radius" needs no special path: the
self-approval is simply not granted.

## "Fully autonomous" would be a lie, so we don't say it

**G2 holds in both modes.** Merging the run branch into your branch is always
your decision. What `auto` buys is an unattended run that ends at a reviewable
run branch with a receipt chain: you come back to `sddx/run-<goal-id>`, read the
run report and the pull request, and decide.

## Which mode to use

| | `human` (default) | `auto` |
|---|---|---|
| Use when | the plan is the risky part: an unfamiliar codebase, a wide blast radius, work you will have to defend | the plan is routine: a shape you have run before, tight scope, good oracles |
| You review | the plan, before anything exists | the run branch, after everything is proven and reviewed |
| Cost of being wrong | seconds: edit or delete the spec | a run branch you discard |

Start in `human`. Move a shape of work to `auto` once you have watched it run a
few times, not a whole project at once.

## The gate is a permission dialog, not a prompt instruction

The boundary proof works because its evidence, an oracle's exit code on two
trees, comes from processes the model cannot forge. Approval is a different
shape:

| | Boundary proof | Approval |
| --- | --- | --- |
| Shape | a check on evidence | a positive act |
| Evidence | exit codes on the base and the finished tree | a person's intent |
| Forgeable by the model? | no | **yes, trivially**: it is a CLI call |

A model can type `sddx plan approve`. So a check in the CLI alone proves that
the plan started is the plan approved, and nothing about who approved it.

The one thing only a person drives is the harness's own permission dialog. The
sddx plugin raises it from a `PreToolUse` hook with `permissionDecision: "ask"`,
which fires **even when the session auto-accepts permissions**. A permissive
session cannot quietly turn human mode into a no-op. Three rules close the ways
around it:

- **`plan approve` always asks.** Recording approval is the human act, so it is
  the command whose dialog carries the meaning. No mode and no existing token
  pre-satisfies it. `plan start` asks too when no valid token covers the plan.
- **Approval tokens and the config cannot be written by tools.** A file-tool
  write to `.sddx/approvals/` or `.sddx/config.json` is denied in every
  repository, whether or not it uses sddx yet. A shell command naming those
  paths is refused unless it is a plain read. That shell check is textual: it
  sees `..` and doubled slashes but not shell expansion, so it raises the bar
  behind the file-tool block rather than sealing it.
- **The mode is read from `.sddx/config.json` only.** There is no `--mode`
  flag and no environment variable: either would be part of the command line
  the agent composes, so honoring it would let the constrained thing switch off
  the constraint.

Four tiers, weakest first. sddx stacks all of them because the first three are
cheap:

```
 tier 0  a system prompt saying "wait for approval"   theatre on its own
 tier 1  approval token over the spec's sha256        approve-A-start-B impossible
 tier 2  PreToolUse "ask" permission dialog           the model cannot self-grant
 tier 3  ssh-signed approval, touch-required key      cryptographically human-bound
```

The gate also **fails closed**: an unreadable config, an unreadable plan, an
unexpected error, or a missing Bun all resolve to `ask`. A gate that checks
evidence can fail open and lose one assertion; a permission gate that fails
open disables the mode you chose.

### What sddx can and cannot prove

- **Can prove:** which plan a receipt descends from (`plan_sha256`), which mode
  it ran under, and, with a valid signature, that the approval was made with the
  named signer's key.
- **Cannot prove:** that a person approved, unless the approval was signed with
  a key that needs a touch or a passphrase. The dialog leaves no trace a third
  party can check, so a receipt records the harness only as reported
  (`harness_reported`), and its approval `binding` is `signed` only when a
  signature verifies.

`sddx audit` is worded to stay inside that claim: it reports human approval as
provable only for a signed binding.

## The plan is the spec

There is no separate plan document. The goal's spec file,
`.sddx/specs/<date>-<slug>.md`, holds the design and the tasks, and it is what
you approve. Approving hashes its bytes:

```
 Review   → sddx plan check <spec>     the hash, the base commit, the task count
 Approve  → sddx plan approve <spec>   raises your dialog
 Start    → sddx plan start <spec>     refuses without a matching approval
 Edit     → edit the spec, commit, check and approve again
 Cancel   → delete or never start the spec. Nothing else exists yet.
```

`plan check` runs the same validation `plan start` runs and writes nothing, so a
plan that would be refused never costs you a read. The spec must be committed:
the plan you start is then in history.

### Any edit invalidates approval, on purpose

The approval covers the spec file's raw bytes. Reordering tasks invalidates it;
so does a comment. A semantic hash would have to enumerate every meaningful
field, and missing one, say `retry.max_attempts`, would let an edit from 1 to 50
through silently approved. A false invalidation costs one re-approval. A false
validation is unbounded.

## Approval reaches the receipt chain

Every receipt a goal produces carries how its plan was approved:

```jsonc
"approval": {
  "mode": "human",
  "plan_sha256": "2b36…",
  "assumptions": [],
  "amendments": [],
  "binding": "unsigned",
  "harness_reported": "claude-code"
}
```

So `sddx audit` answers more than "is this chain intact": it says whether the
work was approved by a person, against exactly which plan, and whether that is
provable. A receipt recording `mode: auto` is a permanent, honest marker that no
person approved that plan.

`assumptions` are copied onto the receipt rather than looked up at read time: a
receipt that needs another file to be understood stops being a receipt.
`amendments` is reserved and always empty. Plans are frozen once approved: a
task that turns out to be wrong fails or is abandoned, and you revise the spec
and approve it again.

## Auto mode's bounds

Every bound is a **hard refusal**. None prompts or falls back to asking you,
because a run recorded as `auto` must never have a human approval hiding
underneath it.

| Bound | Why it is the right proxy |
|---|---|
| a `manual` oracle | a person must observe the result, and an unattended run has nobody. `browser` is fine: a headless browser oracle really runs |
| a strict-profile `task allow` exemption | the allow list is the only escape from the strict gate; a run that could widen its own gate has none. It needs a person in both modes |
| a task with no `scope` | unconfined: it may write anything, including every path below |
| a `scope` reaching `hooks/**`, `templates/**`, `dist/**`, `bin/**`, `.claude/**` or CI workflows | a plan that edits the machinery enforcing the plan, including the compiled gates that actually run |
| a `scope` naming `auth`, `migrations`, `secrets`, `credentials` or `billing`, or reaching `infra/**`, `terraform/**`, `k8s/**`, a `Dockerfile*`, a `docker-compose*` or a `.env*` | a security, data, billing or deployment decision is not one an unattended run may take |
| items under `### Open decisions` | the plan rests on a choice nobody has made |
| more tasks than `auto_max_tasks` (default 6) | blast radius: one worktree per task |

The path bounds use two matchers, because one does not work. Plain glob overlap
asks whether any path could match both patterns, and against `**/auth/**` that
is true of every scope ending in `**`: `src/widget/**` overlaps it through
`src/widget/auth/x`. So a scope counts as protected when a literal segment of
its pattern names a protected area at any depth, or when it overlaps a
root-anchored location such as `infra/**`. A broad scope naming nothing
protected, such as `src/**`, passes even though it could write
`src/auth/session.ts`. Closing that gap would mean refusing every broad scope;
the unconfined bound catches the extreme case, and human mode reviews the rest.

### A human blocker and an auto blocker are different events

| | human mode | auto mode |
|---|---|---|
| what stopped it | the plan is ready and waiting for you | an autonomy bound was exceeded |
| `sddx plan start` exits | `3`: approval required | `1`: refused |
| how to continue | review and approve | **not** by approving: narrow the scope, resolve the decision, split the goal, or set `"interaction_mode": "human"` in `.sddx/config.json` and review it yourself |

A human blocker is a pause; an auto blocker is a refusal. In both cases nothing
was created: no goal record, run branch, task, worktree or approval.

## Questions are gated on what they produce

Brainstorming is an open conversation: the agent asks one question at a time,
as many as the design needs, and you can answer "skip". What sddx checks is the
result. `sddx spec check` requires the design's sections, and the plan gates
refuse a spec while `### Open decisions` lists anything. Before finishing, the
brainstorm skill checks that every Acceptance line can become an executable
oracle; a line that cannot is the one question still owed.

In `auto` mode the agent asks nothing: it decides, and records each decision
under `### Assumptions`. A decision it cannot safely make stays under
`### Open decisions`, which refuses the run.

## Resume never re-asks

Approval is per plan hash, and `plan start` runs once per goal. Starting tasks,
verifying and reviewing need no approval, so an interrupted run carries on with
no prompt. Only a new plan, or a changed one, meets the gate again. A gate that
nags on every resume gets clicked through blindly, which is worse than none.

## Incremental confidence is a plan shape

To see one task land before committing to the rest, draw it into the plan:

```
   ┌───────┐
   │ spike │ ◄── every other task depends_on it,
   └───┬───┘     with on_dependency_failure: block
    ┌──┼──┐      → a failure halts the goal rather than
    ▼  ▼  ▼        skipping past it (the skip default)
   [a][b][c]
```

There is deliberately no per-task approval. Reviewing every action is the
anti-pattern this design avoids; the dependency graph already expresses staged
confidence.

## Configuration

```jsonc
// .sddx/config.json
{
  "interaction_mode": "human", // human | auto (default: human)
  "auto_max_tasks": 6 // positive integer (default: 6)
}
```

These keys are config-only: no flag, no environment variable. For unattended CI,
commit `"interaction_mode": "auto"`. An unreadable config, a typo or an
out-of-range value all resolve to `human`: nothing can accidentally yield
unattended execution.

## Headless and deferred approval

In `human` mode, `plan start` without an approval writes nothing and exits 3,
naming the plan's hash, so a pending plan is durable for free: the committed
spec is the approval request. Under `claude -p` there is no dialog, so the agent
cannot approve; a person approves later, from any interactive session or a
terminal on any machine with the repository, and `plan start` then proceeds.
