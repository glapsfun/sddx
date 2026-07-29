---
name: run
description: Flagship sddx flow — decompose a goal into oracle-backed task specs and run them through TDD loops in parallel git worktrees, each ending in a verified, hash-chained receipt. Use for multi-task goals or any task that should run isolated from the current checkout.
---

# /sddx:run

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Trivial single task and the user wants it in-session? `--solo` → follow
/sddx:quick instead (same gates, no subagents, no worktree). If the goal looks
like a single trivial task, run `... config show --output json` first and
check `.data.prefer_solo` — when true, lean toward suggesting
`--solo`/`/sddx:quick` unless the user already asked for `/sddx:run`
explicitly. This is advisory only: no hook enforces it, it's a steer for this
skill's own judgment.

## Interaction modes

Two modes, **one** execution engine: they differ only in whether the
plan-approval gate is armed. `human` (the default) pauses for approval before
anything is created; `auto` runs unattended up to the run branch. Everything
after approval — executors, verifiers, phase machine, receipts, the final
summary — is identical, and `auto` is simply `human` with the gate
pre-satisfied.

**"Autonomous" stops at the run branch.** Merging or pushing the *target*
branch is always the user's call in both modes (see Rules). Auto mode buys an
unattended run ending in a reviewable branch with a receipt chain — not an
unattended merge.

Read the effective mode from `.data.interaction_mode` in step 0. There is **no
`--mode` flag and no environment override** — mode lives in `.sddx/config.json`
alone, precisely so a command line you compose cannot switch off the gate you are
subject to. Do not try to pass one. Under `human`,
your responsibilities are: run the one intake question round and render its
batch (step 0.5), present the rendered plan, and **never invoke
`graph create` before approval**. Under `auto`: ask nothing, expect open
questions resolved conservatively and recorded as `assumptions` with rationale,
continue without interruption, and produce the summary. A decision `auto` cannot
safely take lands in the header's `unresolved` list, which **refuses** the run
rather than degrading it to a prompt.

These are behavioral instructions layered on top of a deterministic gate, and
they are **not** the mechanism enforcing approval. A PreToolUse hook raises the
user's own permission dialog on `graph create`, and `graph create` itself exits
3 without an approval token. If you ignore this section, the gate still holds —
which is the point.

## Flow

0. **Read config** — run `... config show --output json` once and keep
   `.data.agent_model` (a `role=model` map, e.g. `{"tddExecutor": "opus"}`) for
   step 1 onward: when dispatching a subagent for a role present in that map,
   pass its model as the dispatch's model override; roles absent from the map
   use the harness default. Also keep `.data.interaction_mode` (`human`|`auto`)
   and `.data.auto_max_tasks`. (`--json` still works as a deprecated alias for
   `--output json`, but reads the same `.data.*` shape — not the bare fields
   an older sddx once printed at the top level.)
0.5 **Intake — interpret the goal before decomposing it.** Dispatch the
   `intake` agent with the raw goal and the effective mode. It researches the
   repo and writes the **Goal Brief header** of
   `.sddx/drafts/<date>-<goal-slug>-graph.yaml` — `schema_version`,
   `interaction_mode`, `goal`, and whichever of `answers`, `assumptions`,
   `constraints`, `acceptance_criteria`, `out_of_scope`, `unresolved` apply —
   and **no `tasks:` key**. A draft without `tasks:` fails parsing by design, so
   an intake-only header cannot be fingerprinted, approved, or materialized.

   **A subagent has no channel to the user, so intake cannot ask anything.** It
   *returns* its question batch to you; you render it. Write what it returned to
   `.sddx/drafts/<date>-<goal-slug>-questions.yaml` and run
   `... intake check --batch <path>` **before showing anything**. That command
   enforces the three-question cap and the shape of each entry; over the cap it
   exits nonzero naming the cap rather than truncating. Do not render an
   unchecked batch.

   Then, under `human`: ask the user the (at most three) questions in **one**
   round, each with why it matters and its recommended default. Fold every
   answer — and every default the user explicitly accepted — into the header's
   `answers` list, keyed by the question's id. Under `auto`: ask nothing, and
   expect intake to have recorded conservative defaults as `assumptions` with
   rationale instead.

   **One batch, one dispatch.** Do not re-dispatch intake to look for more
   questions once the user has answered — a second cold subagent re-reads the
   repository to ask what the first round should have asked, which is the token
   cost this flow exists to avoid. A question that was missed surfaces at the
   plan summary in step 2.5, where **Edit** and **Regenerate** already exist.
   The one reason to re-dispatch is the user **changing the goal itself**; in
   that case hand the existing `answers` back to intake, which retains those
   still valid and re-asks only the genuinely affected ones.

   A well-specified goal returns a complete header and **zero** questions. Go
   straight to step 1 — that is a success, not a shortfall.
1. **Decompose into a graph** — dispatch the `orchestrator` agent with the goal
   and the header intake wrote. It **appends `tasks:`** to that same draft
   (`.sddx/drafts/<date>-<goal-slug>-graph.yaml`), never rewriting the header
   and never restarting requirements discovery: one node per task
   with an `alias`, a `spec` path (a bare filename alongside the graph file —
   `graph create` resolves it relative to `graph.yaml`'s own directory), and
   `depends_on` naming **zero or more** sibling aliases (a scalar for one
   parent, a list for fan-in). The graph is a cycle-free DAG, not just a
   forest — a node may have several parents (fan-in) as well as several
   children (fan-out). Concurrent tasks (neither reachable from the other via
   `depends_on`, which also covers two parents feeding the same fan-in child)
   must have **disjoint `scope`**; overlapping scope must be ordered with an
   edge. One task is fine — a single-task run is the degenerate case.
2. **Plan** — one `planner` per node writes its spec YAML alongside the graph
   file under `.sddx/drafts/`, including a `scope`, an executable oracle (no
   oracle, no goal), and — only where a lane genuinely warrants it —
   `on_dependency_failure` (`skip`, the default, or `block`) and `retry`
   (`max_attempts`, `workspace: fresh|reuse`). Leave both unset for the common
   case; they default to today's behavior (skip past an unrecoverable
   ancestor, no automatic retry).
2.5 **Render the plan and get approval** — run
   `... graph create --graph <path> --dry-run`. This runs the *same*
   resolve-and-validate path a real create runs and writes nothing, so it
   reports what the drafts cannot: the effective workspace mode (including any
   submodule downgrade), the resolved base SHA, and the validation verdict.
   Relay it. A re-render after a revision prints only what changed, so a second
   read is cheap.

   Offer **exactly these four** actions and take none of them unasked. There is
   no fifth: everything else belongs to the goal-scoped Next Actions menu after
   the run summary, and the two menus are never combined.
   - **Approve** → `... graph approve --graph <path>` (pass the same
     `--workspace` you will create with — the token records it), then step 3.
   - **Edit** → revise the draft YAML (the drafts *are* the plan), re-render.
     Any edit changes the plan hash, so the gate arms again — expected, not a
     bug. An edit to an **answer or the goal** goes back to the header and needs
     a fresh decomposition before the summary is shown again; an edit to only
     the decomposition re-renders from step 2.5.
   - **Regenerate** → `... graph regenerate --graph <path>`, then return to
     step 1 for a fresh decomposition. It truncates the draft back to its
     header keys and removes the node spec drafts. Every recorded answer
     survives untouched, because the answers *are* the part of the file that is
     kept — no question is re-asked and intake is not re-dispatched.
   - **Cancel** → `... graph cancel --graph <path>`. **Nothing else needs
     undoing** — no branch, worktree, or state file exists yet. This is why the
     gate sits here.

   Under `auto` **no menu is rendered and no selection is waited for** — render
   the summary for the record and continue. A plan passing every autonomy bound
   is authorized by the mode itself, recorded as `auto`, never as a human
   approval.

   Every autonomy bound is a **hard refusal**, not a degradation to a prompt:
   there is no "approve your way past it". `auto` refuses when the plan exceeds
   `auto_max_tasks`; when any node's `scope` reaches sddx's own enforcement
   paths (`hooks/**`, `.claude-plugin/**`, `dist/**`, `bin/**`, `.claude/**`,
   CI workflows) or a protected area (auth, migrations, secrets, credentials,
   billing, `infra/**`, `terraform/**`, `k8s/**`, Dockerfiles, `.env*`); when a
   node declares no `scope` at all (unconfined); when the header carries a
   non-empty `unresolved` list; when `--workspace none` would run tasks in the
   live checkout; when a node's `oracle.type` is `manual` (nobody is present to
   observe it); or on a `task allow` TDD-gate exemption (an agent that can
   widen its own gate has no gate). Each refusal names the reviewed-configuration
   edit that would let a human run it instead.
3. **Create atomically** — from the repo root:
   `... graph create --graph .sddx/drafts/<date>-<goal-slug>-graph.yaml`
   This is the gate: it validates every oracle, the DAG (cycle-free, and
   **overlap ⟹ ordered** across every unordered pair — including fan-in
   co-parents), and every `on_dependency_failure`/`retry` value, then creates
   the goal's run branch (`sddx/run-<goal-id>`, forked from the resolved
   `origin/HEAD`) and writes all task files (worktrees forked from that same
   run branch for roots; dependents deferred) and `.sddx/goals/<goal-id>.json`
   with its edges — or writes **nothing** and names the offending node. Auto
   downgrades to branch mode (one notice) when worktrees are unsafe. Record
   the printed alias→id map, goal id, and run branch name.
4. **Execute as a fan-in-aware chain-walk** — dispatch a `tdd-executor` for
   every **ready** task (a root, or one whose parents are *all* DONE) in a
   single message, each given its task id and worktree path. Executors never
   leave their worktree and run `... red-check <id>` once RED is recorded,
   before implementing.
5. **Verify and advance** — per finished task, dispatch a `verifier` (only
   `sddx verify` sets DONE and writes the receipt). On a pass, `sddx verify`
   also merges the task's commit into the goal's run branch automatically, as
   part of the same command — no separate ask; this is the one exception to
   "merging is the user's decision" (see Rules), scoped to the disposable run
   branch only, never the target branch. A merge conflict here is reported,
   not silently resolved: the task keeps its DONE phase and receipt, but is
   flagged as verified-and-not-yet-integrated. Each dispatched verifier
   follows /sddx:verify, which reports the receipt, the commit, and the
   integration result — and nothing else. There is no per-task menu: the run
   has exactly one handoff, shown after the run summary.
   When every parent of a child reaches DONE, materialize it with
   `... task materialize <child-id>` — forks from its sole parent's commit, or
   sequentially merges every parent's commit for a fan-in child (safe by
   construction: the graph gate already proved their scopes disjoint) — then
   dispatch it. If a task exhausts its retries and lands on ABANDONED, its
   dependents resolve per their own `on_dependency_failure`: **skip**-policy
   dependents (the default) are marked **Skipped** and the walk continues past
   them without halting the rest of the goal; **block**-policy dependents stay
   **Blocked** and escalate, exactly as an unresolved parent does. Repeat until
   the graph drains or every remaining branch is blocked/skipped.
6. **Report** — run `... board --output markdown` and relay it: task rows
   (id · branch · **status** — Ready / Running / Blocked / Skipped / Completed,
   plus a task's own Abandoned marker — including `blocked-on-<id>` /
   `skipped-on-<id>`) and receipt references come from the same board data
   that `.sddx/BOARD.md` is built from, so the report and the committed board
   can never disagree. Prefer `--output json` instead when relaying to another
   tool/agent rather than a human. Then run
   `... run report --goal <goal-id>` and relay it — the run branch name, the
   target branch (unchanged), merged/failed/outstanding counts, a diff
   summary, and the review commands (`git switch`, `git diff`, `git log`).
   This is meaningful even when the goal is only partially done: the run
   branch already reflects whatever verified so far. The report is **identical
   in both modes** — same sections, same order — and also carries the goal
   sentence, per-task oracle outcomes, the approval line (effective mode, plan
   hash, and the authorization type — `human-approval` or `auto`), the answers
   the user gave, and any assumptions recorded during the run. Then run
   `... next-actions --goal <goal-id>` and relay its menu — review, retry a
   failed task, revert one task's merge, commit remaining changes, push the
   run branch, create a PR/MR, merge into the target branch, exit — offer it,
   never act on it unasked. Finally run `... sweep` to clear disposable
   leftovers (it skips anything dirty or unverified, loudly).

## Resume

Re-invoking `/sddx:run` on a goal that already has some tasks DONE (or
Skipped/Abandoned) picks up where it left off — no daemon, no separate resume
state. Step 4's readiness check (`board`/`task show`) already recomputes
Ready/Blocked/Skipped/Completed from `.sddx/tasks/*.json` and
`.sddx/receipts/*.json` alone on every invocation: a task with a valid receipt
is a satisfied dependency node and is never redispatched; a terminal
Skipped/Abandoned task is never redispatched either; only currently-Ready or
still-in-flight tasks get dispatched. This holds even across a crash or a
killed session between invocations — read the board before dispatching
anything and act only on what it reports as Ready.

**Resume never re-asks for approval.** The gate is armed only on `graph create`,
and creation does not re-run for an existing goal — so an interrupted `human`
run picks up its Ready tasks with no prompt. Approval is per-plan-hash: only a
new plan, or one whose drafts changed, meets the gate again.

## Incremental confidence is a graph shape, not a gate

If the user wants to see one task land before committing to the rest, that is
**not** a second approval gate — it is how the graph is drawn. Plan a canary
node that every other node `depends_on`, with `on_dependency_failure: block` so
a failure halts the graph instead of skipping past it:

```yaml
tasks:
  - alias: spike          # the canary
    spec: <date>-<slug>-spike.yaml
  - alias: rest
    spec: <date>-<slug>-rest.yaml
    depends_on: spike     # spec sets on_dependency_failure: block
```

There is deliberately **no per-task approval prompt** — reviewing every action
is the anti-pattern this design rejects. One gate, at the plan.

## Rules

- Merging into the **original target branch** — and pushing or merging
  anything to it — is always the **user's** decision; nothing here ever does
  either automatically. Merging a *verified* task into its own goal's
  disposable run branch is different: `sddx verify` does that automatically,
  by design, since the run branch is sddx's own scratch integration surface,
  not the user's branch. Pushing the run branch, opening a PR/MR from it, or
  merging it into the target branch are, in turn, the user's decision again —
  offer via the run-scoped Next Actions menu; never do any of them unasked.
- A task that exhausts its spec's `stop_rules` (default max_iterations) and
  has no retry budget left stops and is reported ABANDONED — escalate to the
  human, don't loop forever. (A task with `retry.max_attempts` > 1 gets
  additional automatic attempts before that happens — see `retryWorkspace`.)
- Never dispatch two tasks whose specs touch the same files; re-decompose
  instead. This isn't just a parallel-safety rule — it's also what keeps each
  task's automatic merge into the run branch conflict-free.
- State lives in `.sddx/` inside each task's own workspace and merges without
  conflict — one file per task, no exceptions. The goal file is the one
  exception that lives in the main checkout, since it spans multiple tasks'
  workspaces by definition — and, unlike task/receipt files, it's never
  committed (plain local coordination state, like `.sddx/sweep.json`), so it
  stays visible regardless of which branch happens to be checked out.
