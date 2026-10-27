# Model DAG dependencies

`depends_on` in a task's `sddx` block turns a goal's tasks into a general DAG:
fan-out (one parent, several children) and fan-in (several parents, one
child). This guide covers the rule that keeps it safe and how a dependent's
worktree is built. A runnable walkthrough is
[examples/03-dag-dependencies](../../examples/03-dag-dependencies/).

## Fan-out and fan-in

````markdown
### a Parser

```sddx
oracle:
  type: command
  run: bun test tests/parser.test.ts
  expect: exit 0
scope: [src/parser/**, tests/parser.test.ts]
```

### b Renderer

```sddx
oracle:
  type: command
  run: bun test tests/renderer.test.ts
  expect: exit 0
scope: [src/renderer/**, tests/renderer.test.ts]
```

### c Pipeline

```sddx
oracle:
  type: command
  run: bun test tests/pipeline.test.ts
  expect: exit 0
scope: [src/pipeline.ts, tests/pipeline.test.ts]
depends_on: [a, b]
```
````

`depends_on` takes one task id, or a list for several parents.

## The rule: overlap means ordered

Two tasks the plan does not order can run at the same time, so they must have
disjoint `scope`. That includes two parents of the same fan-in child.
`sddx plan check` checks every unordered pair and refuses with:

```
scope overlap between concurrent tasks "<a>" and "<b>"; order one after the other or make their scopes disjoint
```

Nothing is created while the plan is refused. A dependent may overlap its own
ancestor's scope: the edge already orders them.

## How a dependent starts

A task with dependencies stays `PLANNED` until every parent is `DONE`. Then
`sddx task ready --goal <goal-id>` lists it and `sddx task start` creates its
worktree from the tip of the goal's run branch. Every parent was merged into the
run branch when its review passed, so the child starts from all of its parents'
work, with no merge inside its worktree. For a single parent this is the same
rule.

If a parent is abandoned instead, see
[Configure retry and skip/block](configure-retry-and-skip.md).
