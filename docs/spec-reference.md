# Spec reference

A task spec is one YAML file. The parser (`src/lib/spec.ts`) rejects a spec
that is missing a task sentence, success criteria, or an oracle — registration
fails with the exact errors listed per field below.

A complete example:

```yaml
task: health endpoint returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
```

## task

One sentence stating the goal. Required and non-empty
(`task: one-sentence description required` otherwise). It is also the source
of the task id: `YYYYMMDD-<slug>`, where the slug is derived from this
sentence.

## context

A list of pointers — file paths, CONTEXT.md sections — not prose. Optional
(defaults to empty). Links keep the spec dense; anything the executor must
read belongs here, anything it must *know* belongs in the linked file.

## success_criteria

A non-empty list of strings, each one binary and observable
(`success_criteria: non-empty list of binary criteria required` otherwise).

| Criterion                                        | Verdict | Why                                             |
| ------------------------------------------------ | ------- | ----------------------------------------------- |
| `"GET /health returns 200 with {status: ok}"`    | good    | One observable check, true or false             |
| `"bun test tests/health.test.ts exits 0"`        | good    | An exit code — the most binary signal there is  |
| `"improve error handling"`                       | bad     | Not binary — when is "improved" true?           |
| `"code is cleaner"`                              | bad     | Not observable — no command can decide it       |
| `"faster than before"`                           | bad     | Unmeasured comparative — no baseline, no number |

**What is enforced vs. convention:** the parser enforces the *shape*
(non-empty strings); "binary and observable" is the authoring rule. At
verification the criteria get a prose cross-check that is explicitly
non-binding — the receipt's verdict comes from the oracle's exit code alone.
Criteria that restate the oracle's observable outcome (like the good examples
above) make that cross-check meaningful; vague ones make it noise.

## oracle

The mandatory proof. **A spec without an oracle is rejected at registration —
no oracle, no goal** (`oracle: required — no oracle, no goal`).

Fields: `type`, `run`, `expect`, `runs`. `expect` defaults to `exit 0` when
omitted. `run` is required for every type except `manual`
(`oracle.run: command required for non-manual oracles`).

- `runs` (optional, integer ≥ 1, default 1): verify executes the oracle this
  many times sequentially; **every** run must exit as expected. Repo default:
  userConfig `oracle_runs_default`. Receipt v3 records each run.

Four types (`oracle.type: must be one of command | test-suite | browser |
manual` otherwise):

```yaml
oracle: # command — any shell command; the default choice
  type: command
  run: "curl -sf localhost:3000/health"
  expect: exit 0
```

```yaml
oracle: # test-suite — the project's test runner as the proof
  type: test-suite
  run: "bun test"
  expect: exit 0
```

```yaml
oracle: # browser — a scripted browser check (e.g. playwright)
  type: browser
  run: "bunx playwright test e2e/login.spec.ts"
  expect: exit 0
```

```yaml
oracle: # manual — a human signs off; run may be empty
  type: manual
  run: ""
  expect: "human approves the rendered page"
```

Prefer `command`/`test-suite`: the verifier executes `run` and compares the
exit code against `expect`, so the proof is mechanical. `manual` exists for
genuinely non-automatable outcomes and puts a human in the verify step.

## stop_rules

Loop bounds — what stops an executor from iterating forever. Optional list;
entries are either a mapping like `max_iterations: 5` (default from the
plugin's `max_iterations_default` setting) or a free-form escalation string:

```yaml
stop_rules:
  - max_iterations: 5
  - "oracle unreachable after 2 attempts → escalate to human"
```

When a rule trips, the task stops and is reported as stuck — escalated to the
human, never silently retried past the bound. The current iteration count
lives in `.sddx/tasks/<id>.json`.

## out_of_scope

Explicit exclusions so the loop doesn't wander. Optional list. Anything named
here is off-limits to the executor even if it seems adjacent to the goal:

```yaml
out_of_scope:
  - "auth, rate limiting"
  - "refactoring unrelated modules"
```
