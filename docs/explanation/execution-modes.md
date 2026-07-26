# Execution modes: human-in-the-loop and unattended

sddx has two execution modes. They are **not** two workflows — there is one
execution engine, one receipt format, one completion summary. They differ only
in whether the plan-approval gate is armed.

```
 goal ─► discover ─► clarify ─► plan ──[G1]──► execute ─► verify ─► run branch ──[G2]──► target
                        ▲                ▲                                          ▲
                       G0                │                                          │
        ask only what blocks       human: ARMED                              ALWAYS ARMED
        an oracle; assume          auto:  self-approved                      both modes.
        the rest                          unless a bound trips               no exceptions.
```

`auto` is `human` with G1 pre-satisfied. That is not a metaphor — it is how the
code works, which is why "the plan exceeded its blast radius" needs no special
path: the token simply is not granted and the gate arms as it always would.

## "Fully autonomous" would be a lie, so we don't say it

**G2 is armed in both modes.** Merging or pushing the *target* branch is always
the user's decision — that guarantee predates this feature and is unchanged.

What `auto` actually buys you is an **unattended run ending at a reviewable run
branch with a receipt chain**. You come back to `sddx/run-<goal>`, read the
report, and decide. That is a better proposition than an unattended merge, and
it is the honest one.

## Which mode to use

| | `human` (default) | `auto` |
|---|---|---|
| Use when | the plan is the risky part — unfamiliar codebase, wide blast radius, work you'll have to defend | the plan is routine — a shape you've run before, tight scope, good oracles |
| You review | the plan, before anything exists | the run branch, after everything is verified |
| Cost of being wrong | seconds (delete the drafts) | a run branch you discard |

Start in `human`. Move a *shape* of task to `auto` once you've watched it work
a few times — not a whole project at once.

## The gate is a permission dialog, not a prompt instruction

This is the part that matters, and it is worth being precise about why.

The TDD gate works because its evidence — a test runner's exit code — comes from
a process the model cannot forge. Approval is a different shape:

| | TDD gate | Approval gate |
| --- | --- | --- |
| Shape | **prohibition** — deny a write | **permission** — a positive act |
| Evidence | test-runner exit code | a human's intent |
| Forgeable by the model? | no | **yes, trivially** — it is a CLI call |

A model can type `sddx graph approve`. So a CLI-only gate proves the plan that
runs is the plan that was approved — and nothing about who approved it.

The one external process only a human drives is the harness's own permission
dialog. sddx raises it from a `PreToolUse` hook using `permissionDecision:
"ask"`, which per the hook API fires **even when the session is in an
auto-accept permission mode**. A permissive session config cannot silently turn
human mode into a no-op.

Three things make that airtight, and each closes a way the gate was defeatable:

- **`graph approve` is gated too, and always asks.** Gating only `graph create`
  left the obvious hole: run `graph approve` first, and `create` then finds a
  token and sails through. Recording approval *is* the human act, so it is the
  command whose dialog carries the meaning — no mode and no existing token
  pre-satisfies it.
- **Approval tokens cannot be written by hand.** `.sddx/**` is exempt from the
  TDD gate, so a direct `Write` to `.sddx/approvals/` would forge a token. That
  path is now blocked unconditionally, in every phase, task or no task.
- **Mode is read from `.sddx/config.json` only.** A `--mode` flag or an inline
  `SDDX_EXECUTION_MODE=auto` is part of the command line the agent composes, so
  honoring either would let the constrained thing switch off the constraint.
  There is no `--mode` flag.

Four tiers, weakest first. sddx stacks all of them because 1–3 are cheap:

```
 tier 0  a system prompt saying "wait for approval"   ← theatre on its own
 tier 1  approval token + plan_sha256                 ← approve-A-execute-B impossible
 tier 2  PreToolUse "ask" permission dialog           ← model cannot self-grant
 tier 3  ssh-signed token, touch-required key         ← cryptographically human-bound
```

The gate also **fails closed**: any error inside it — unreadable config, corrupt
token, an unexpected throw — resolves to `ask`. A prohibition gate that fails
open loses one assertion; a permission gate that fails open disables the mode
the user chose.

### What sddx can and cannot prove

Stated plainly, because the framework's credibility depends on not overclaiming:

- **Can prove:** which plan a receipt descends from (`plan_sha256`), which mode
  it ran under, and — with a valid signature — that it was produced by the named
  signer's key.
- **Cannot prove:** that a particular human approved, unless a touch-required
  hardware key (`sk-*`) is configured. With a passphrase-less file key or a
  cached agent, the model's own shell can sign, so tier 3 collapses to tier 1.

`sddx audit` is worded to stay inside that claim.

## The plan is the drafts

There is no separate plan document. `.sddx/drafts/<date>-<slug>-graph.yaml` plus
its spec files **is** the plan, which is why "edit the plan" means editing YAML
and "cancel" means `rm`.

```
 Approve     → sddx graph approve --graph <path>
 Edit        → edit the YAML, re-render (shows only what changed)
 Regenerate  → delete the drafts, re-plan
 Cancel      → delete the drafts. nothing else to undo.
```

Review it with `sddx graph create --graph <path> --dry-run`, which runs the
*same* resolve-and-validate path a real create runs and writes nothing. That
matters: three facts a human needs are decided inside `graph create` and are
absent from the drafts — the effective workspace mode (including the submodule
auto-downgrade), the resolved base SHA, and the validation verdict. Approving
without them would mean approving less than the command knows.

Validation runs **before** you are asked, so a plan that would be rejected never
costs you a read.

### Any edit invalidates approval, on purpose

`plan_sha256` covers the graph file's raw bytes plus every referenced spec's
bytes. Reordering nodes invalidates it. A comment change invalidates it.

The token additionally records the **workspace strategy** it was approved under,
so pass the same `--workspace` to `approve` and `create`. Approving a `worktree`
render does not authorize `--workspace none`, which would move every task out of
its isolated worktree and into your live checkout; the mismatch exits 3.

That is deliberate. A canonical *semantic* hash would have to enumerate every
meaningful field correctly, and missing one — say `retry.max_attempts` — would
leave an edit from 1 to 50 silently approved. False invalidation costs a
re-approval, and a re-render shows only the diff. False validation is unbounded.

## Approval reaches the receipt chain

Every receipt a goal produces carries the mode and the plan hash it descends
from (schema v4):

```jsonc
"approval": {
  "mode": "auto",
  "plan_sha256": "9f2c…",
  "assumptions": ["the project uses Vite"],
  "amendments": []
}
```

So `sddx audit` answers a question it could not before: not just "is this chain
intact" but **"was this work human-approved, and against exactly which plan?"**
A receipt recording `mode: auto` is a permanent, honest marker that no human saw
that plan — reviewers can filter on it.

`assumptions` are denormalized onto the receipt rather than resolved through the
goal at read time. A receipt that needs another file to be interpreted stops
being a receipt.

`amendments` is **reserved and always empty** in this version. Plans are frozen
after approval: a later task whose spec turns out stale fails its oracle, goes
ABANDONED, and escalates — you re-plan and re-approve. Mid-run per-node
amendment (with its own scoped approval and a recorded spec diff) is the natural
next step, and the field exists now so the receipt shape stays stable when it
lands.

## Auto mode's bounds

Two are **hard refusals** — not thresholds, not configurable. They fail rather
than prompting, because asking a human to approve an incoherent plan is worse
than refusing it:

1. **A `manual` oracle.** It means a human observes the result; an unattended
   run has nobody. That is incoherence, not risk appetite. (`browser` is fine —
   headless browser oracles genuinely execute.)
2. **Granting a `task allow` TDD-gate exemption.** The allow-list is the only
   escape hatch from the TDD gate. An unattended run that could widen its own
   gate would have no gate. Exemptions need a human in **both** modes.

Two more **arm the gate** rather than failing — nothing is lost, the drafts are
already written:

| Bound | Why it's the right proxy |
|---|---|
| node count > `auto_max_tasks` (default 6) | blast radius ≈ worktrees forked |
| any `scope` reaching `hooks/**`, `.claude-plugin/**`, or CI workflows | a plan that edits the machinery enforcing the plan |

That second check is unconditional — it ignores the node count entirely. It
reuses the same glob-overlap primitive the `overlap ⟹ ordered` rule uses, asked
a different question.

Degradation is recorded, never silent: the goal and every receipt carry
`requested_mode: auto` alongside the effective `mode: human` and the bound that
tripped.

## Clarification questions are oracle-blockers

"Ask only high-value questions" is unenforceable. sddx uses a nearly mechanical
rule instead, and it is one the framework already had:

> **If you can write the oracle, you don't get to ask.**

The planner already must report back rather than emit a spec when it cannot name
an executable success signal. That escalation — previously swallowed inside a
subagent — is the pre-planning gate.

| Question | Blocks an oracle? | What happens |
|---|---|---|
| "Which test runner?" | yes — `oracle.run` is unwritable | asked |
| "Is auth in scope?" | yes — changes `success_criteria` | asked |
| "Who's the target audience?" | no | assumed, recorded |
| "Preferred brand colors?" | no | assumed, recorded |

This also defines the one condition that halts an unattended run: **an oracle
that cannot be named even after conservative assumption.** Not a vibe — a
testable state.

## Resume never re-asks

Approval is **per-plan-hash**, and the gate is armed only on `graph create`,
which does not re-run for an existing goal. So an interrupted `human` run picks
up its Ready tasks with no prompt. Only a new plan, or one whose drafts changed,
meets the gate again.

This is what keeps human mode livable. A gate that nags on every resume gets
clicked through blindly, which is worse than no gate at all.

## Incremental confidence is a graph shape

If you want to see one task land before committing to the rest, that is not a
second gate — it is how you draw the graph:

```
   ┌───────┐
   │ spike │ ◄── every other node depends_on it,
   └───┬───┘     with on_dependency_failure: block
    ┌──┼──┐      → a failure halts the graph rather than
    ▼  ▼  ▼        skipping past it (the skip default)
   [a][b][c]
```

There is deliberately **no per-task approval prompt**. Reviewing every action is
the anti-pattern this design exists to avoid; the DAG already expresses staged
confidence.

## Configuration

```jsonc
// .sddx/config.json — materialized from the plugin manifest's userConfig
{
  "execution_mode": "human",  // human | auto        (default: human)
  "auto_max_tasks": 6         // positive integer    (default: 6)
}
```

These two keys are **config-only** — no CLI flag, no environment variable, unlike
every other key. That is the point: both would otherwise be command-line surface
the agent composes, and therefore a way to switch off its own constraint. For
unattended CI, commit `execution_mode: "auto"`.

An unreadable config, a typo, or an out-of-domain value all resolve to `human` —
nothing can accidentally yield unattended execution.

`auto_max_tasks` is the one value here not derived from first principles. 6 is a
starting point; tune it to the node counts your goals actually produce.

## Headless and deferred approval

In `human` mode with no token, `graph create` writes **nothing** and exits **3**
(distinct from 2 for usage and 1 for failure), printing the plan path and its
digest. So a pending plan is durable for free — the drafts *are* the approval
request:

```console
$ sddx graph create --graph .sddx/drafts/2026-07-26-widget-graph.yaml
graph create: no approval on file for plan 9f2c1a4b8e03 — review it with:
  sddx graph create --graph <path> --dry-run
then approve with:
  sddx graph approve --graph <path>
$ echo $?
3
```

A cron job can draft plans overnight and you approve them in the morning, from
any session, on any machine with the repo. Nothing extra was built for that; it
falls out of the gate's placement.
