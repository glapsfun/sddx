# Choose an oracle type

Four `oracle.type` values exist in the spec schema, but they aren't four
different execution paths — three are the same mechanism with different
intent, and the fourth doesn't work yet. A full runnable proof of both facts
is [examples/06-oracle-types](../../examples/06-oracle-types/).

## `command`, `test-suite`, `browser` are mechanically identical

`src/lib/oracle.ts` runs `oracle.run` through `sh -c` and checks the exit
code against `oracle.expect` — every automated type goes through this exact
same function. The `type` field changes nothing about execution; it exists
so a reader of the spec (human or model) understands *what kind* of proof
`run` is, not to select different verifier behavior:

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
oracle: # browser — a scripted browser check (e.g. Playwright)
  type: browser
  run: "bunx playwright test e2e/login.spec.ts"
  expect: exit 0
```

Prefer `command`/`test-suite` for anything a shell command can decide — the
proof is mechanical either way. Reach for `browser` only when the thing
being proven genuinely requires a rendered page (a scripted Playwright/
Puppeteer run, still just a shell command from sddx's point of view).

## `manual` is accepted but not yet verifiable

```yaml
oracle: # manual — a human signs off; run may be empty
  type: manual
  run: ""
  expect: "human approves the rendered page"
```

The spec parser accepts this shape — `run` isn't required when `type` is
`manual` — but `sddx verify` currently throws `"manual oracles need a human
decision; M1 verify supports command oracles"` for any manual-oracle task,
unconditionally. A manual-oracle task can be created and driven through
`RED`/`GREEN`, but cannot currently reach `DONE` through `sddx verify`.

Until manual verification ships, model a genuinely non-automatable outcome
as a proxy check instead — a file a human creates after reviewing, an
approval flag a human flips, anything a `command` oracle can observe — and
keep `type: command`.

## `oracle.runs`

Independent of `type`: `runs` (integer ≥ 1, default from userConfig
`oracle_runs_default`) makes `sddx verify` execute the oracle that many times
sequentially, and **every** run must pass — a flakiness check, not a type.
See [spec-reference.md](../reference/spec-reference.md#oracle).
