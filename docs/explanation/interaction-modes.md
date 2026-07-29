# Interaction modes: human-in-the-loop and unattended

sddx has two interaction modes. They are **not** two workflows — there is one
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
  path is blocked unconditionally for `Edit`/`Write`, in every phase, task or no
  task. Bash is covered too, but by a *textual* check: a command naming the path
  is refused unless it is a plain read (an approval token is not a secret). That
  check sees `..`, doubled slashes and concatenation, and does **not** see shell
  expansion — `.sddx/approv?ls/` or `${d}dx/approvals/` never spell the path out.
  It raises the bar behind the `Edit`/`Write` block; it is not a second proof.
- **Mode is read from `.sddx/config.json` only.** A `--mode` flag or an inline
  `SDDX_INTERACTION_MODE=auto` is part of the command line the agent composes, so
  honoring either would let the constrained thing switch off the constraint.
  There is no `--mode` flag. The file itself is not tool-writable either, for
  the same reason: leaving it open would hand back the same choice one
  indirection later. Edit it yourself; read the effective values with
  `sddx config show`.

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
 Edit        → edit the YAML, re-render (shows the plan, plus what changed)
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
re-approval, and a re-render shows the plan again with the diff called out.
False validation is unbounded.

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

Every bound is a **hard refusal**. None of them prompts, degrades, or arms an
approval gate you could satisfy — because a run recorded `auto` must never have
a human approval hiding underneath it. Asking a human to approve a plan that
tripped an autonomy bound would produce exactly that hybrid.

| Bound | Why it's the right proxy |
|---|---|
| a `manual` oracle | it means a human observes the result; an unattended run has nobody. Incoherence, not risk appetite. (`browser` is fine — headless browser oracles genuinely execute) |
| granting a `task allow` TDD-gate exemption | the allow-list is the only escape hatch from the TDD gate; a run that could widen its own gate has no gate. Needs a human in **both** modes |
| a node with no `scope` at all | unconfined: it may write anything, including every path below. Treating "no scope" as "no reach" would make omitting `scope` the cheapest bypass |
| any `scope` reaching `hooks/**`, `.claude-plugin/**`, `dist/**`, `bin/**`, `.claude/**`, or CI workflows | a plan that edits the machinery enforcing the plan — including the *compiled* gates, which are what actually run |
| any `scope` naming a protected area — `auth`, `migrations`, `secrets`, `credentials`, `billing` — or reaching `infra/**`, `terraform/**`, `k8s/**`, a `Dockerfile*`, a `docker-compose*`, or a `.env*` | a security, data, billing, or deployment decision is not one an unattended run may take |
| a non-empty `unresolved` list in the Goal Brief header | intake reported a decision it could not safely take, so the plan rests on a choice nobody has made |
| node count > `auto_max_tasks` (default 6) | blast radius ≈ worktrees forked |
| `--workspace none` | every task runs in your live checkout instead of an isolated worktree |

The path bounds use **two matchers**, because one does not work. Plain glob
overlap asks "could any path match both", which against a pattern like
`**/auth/**` is true of *every* scope ending in a doubled star — `src/widget/**`
overlaps, since `src/widget/auth/x` matches both. Measured against a naive list,
`src/**`, `docs/**`, and `tests/unit/**` all refused: auto mode would have been
off, not bounded. So a scope is protected when a **literal segment** of its
pattern names a protected area at any depth (catching `services/api/auth/**`
without the wildcard blowup, since a wildcard segment names nothing), or when it
overlaps a root-anchored location like `infra/**`.

A gap is accepted deliberately: a broad scope naming nothing protected
(`src/**`) passes, even though it could write `src/auth/session.ts`. Closing it
means refusing every broad scope, which is the failure mode above. The
unconfined bound catches the extreme case, and human mode reviews the rest.

**The deterministic bounds do not consult the intake role's self-report.** The
`unresolved` list is an *additional* trigger layered on top, never a substitute:
a model that assumes its way past an auth decision and reports nothing unresolved
still cannot run unattended, because the path bound is a code constant with unit
tests rather than a judgment. Not every critical decision is path-shaped
("should signup collect date of birth?"), so `unresolved` catches the residue —
but it is the residue, not the mechanism.

### A human blocker and an auto blocker are different events

Both stop the run before anything is created. They differ in what they are
asking of you.

| | **human mode** | **auto mode** |
|---|---|---|
| what stopped it | the plan is ready and awaiting your decision | an autonomy bound was exceeded |
| what you are shown | the plan summary and four actions — Approve, Edit, Regenerate, Cancel | a structured blocker: the missing decision, its impact, and the recommended next step |
| exit code | `3` — approval required | `1` — refused |
| how to continue | Approve, or edit the drafts and re-render | **not** by approving. Narrow the scope, resolve the decision, split the goal, or set `"interaction_mode": "human"` in `.sddx/config.json` and review it yourself |
| is it an error? | no — it is the gate doing its job | yes: the plan asked for more autonomy than the configuration grants |

A human blocker is a **pause**; an auto blocker is a **refusal**. That is why
the refusal message names a reviewed-configuration edit rather than a command:
mode is config-only precisely so the thing being constrained cannot lift the
constraint. And it never names `--mode` or an environment variable, because
neither exists.

In both cases the drafts survive for inspection, and no goal record, run branch,
task branch, worktree, task state, receipt, or approval token was created.

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

This is now the intake role's job, and it runs before the orchestrator in both
modes. Under `human` it returns **one** batch of at most three questions — a cap
enforced by `sddx intake check`, not by instruction — which the session renders,
since a subagent has no channel to the user. Under `auto` it asks nothing:
open decisions are resolved conservatively and recorded as `assumptions` with
their rationale, and anything that genuinely cannot be decided safely goes in
`unresolved`, which refuses the run.

An oracle that cannot be named even after conservative assumption still halts an
unattended run. Not a vibe — a testable state.

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
  "interaction_mode": "human",  // human | auto        (default: human)
  "auto_max_tasks": 6         // positive integer    (default: 6)
}
```

These two keys are **config-only** — no CLI flag, no environment variable, unlike
every other key. That is the point: both would otherwise be command-line surface
the agent composes, and therefore a way to switch off its own constraint. For
unattended CI, commit `interaction_mode: "auto"`.

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
