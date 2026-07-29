# Model DAG dependencies

`depends_on` in `graph.yaml` turns a flat task set into a general DAG — fan-out
(one parent, several children) **and** fan-in (several parents, one child).
This guide covers the two rules that make it safe, and the two ways a
dependent's workspace gets built. A full runnable walkthrough is
[examples/03-dag-dependencies](../../examples/03-dag-dependencies/).

## The rule: overlap ⟹ ordered

Every pair of tasks a graph does **not** order — including two parents that
both feed the same fan-in child — must have disjoint `scope`. `graph create`
and `goal create` share one checker (`validateSchedule`) that walks every
unordered pair and refuses with `scope overlap between concurrent tasks
"<a>" and "<b>" — order one after the other or make their scopes disjoint`
the moment it finds one. This is checked, atomically, before anything is
created — a violation refuses the whole graph, not just the offending node.

A dependent may legally overlap its *own* ancestor's scope (that's what
`depends_on` buys you): a child scoped `src/a/child.ts` depending on a parent
scoped `src/a/**` is fine, because the edge already orders them.

## Fan-out and fan-in in `graph.yaml`

```yaml
schema_version: "1.0"
interaction_mode: human
goal: ship the dashboard
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
  - alias: c
    spec: specs/c.yaml
    depends_on: a # fan-out: a single parent
  - alias: d
    spec: specs/d.yaml
    depends_on: [a, b] # fan-in: a list of parents
```

`depends_on` is a bare scalar for one parent or a list for several; a legacy
single-string value still reads correctly either way.

## Deferred creation, then materialize

A task with any `depends_on` entries is created **deferred**: no worktree,
base recorded as `pending:<parent-id>[,...]`, status **Blocked** on the board
until every named parent reaches `DONE`. Once unblocked (status flips to
**Ready**), `sddx task materialize <id>` builds the real workspace:

- **One parent** — the worktree forks directly from that parent's `DONE`
  commit (the tip of `sddx/<parent-id>`).
- **Several parents (fan-in)** — the worktree forks from the *first* parent,
  then sequentially `git merge --no-ff` the rest in. This is safe by
  construction: the graph gate already proved every pair of co-parents has
  disjoint scope, so the merge cannot conflict. A conflict aborts
  materialization loudly rather than auto-resolving — never an octopus merge,
  never a rebase.

`sddx task materialize <id>` refuses with `not DONE` if any named parent
hasn't finished yet.

## Fan-in leaves no scratch state behind

A fan-in merge happens inside the dependent's own worktree, forked from the
first-listed parent's commit with each remaining parent merged in sequentially
— never an octopus merge. If a merge conflicts, materialization aborts and
reports the failing SHA rather than auto-resolving: a conflict here means the
`overlap ⟹ ordered` gate had a blind spot, not something to paper over.
