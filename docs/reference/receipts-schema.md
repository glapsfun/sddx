# Receipt schema

One JSON file per task at `.sddx/receipts/<task-id>.json`, written exactly
once, when the task is finalized. Since sddx 6 that happens when a review of
the verified diff passes (`sddx review record <id> --verdict pass`); earlier
versions wrote it from `sddx verify`. A failed verification or review writes
nothing, so `verdict` is always `"pass"`. sddx 6 writes version 5, described
[at the end of this page](#v5-boundary-proof-review-and-approval-binding);
`sddx audit` keeps validating versions 1 to 4 exactly as they were written.

| Field            | Type              | Meaning                                                                  |
| ---------------- | ----------------- | ------------------------------------------------------------------------ |
| `version`        | `1 \| 2 \| 3 \| 4 \| 5` | Receipt schema; v2 added `allow`, v3 added `runs`/`env`, v4 added `approval`, v5 added `spec`/`boundary`/`review`/`profile` |
| `task_id`        | string            | The task this receipt settles                                            |
| `seq`            | number            | Position in the chain; strictly greater than the parent's                |
| `prev`           | string            | sha256 of the parent receipt *file*, or `"genesis"` for the first        |
| `harness`        | string            | Harness that ran the loop (e.g. `claude-code`)                           |
| `model`          | string \| null    | Model provenance, when known                                             |
| `plugin_version` | string            | sddx version that wrote the receipt, read from `package.json` (see note) |
| `oracle`         | `{run, expect}`   | The exact command executed and the expectation                           |
| `exit_code`      | number            | Observed oracle exit code                                                |
| `duration_ms`    | number            | Oracle wall-clock duration                                               |
| `stdout_sha256`  | string            | Hash of the oracle's stdout — output is attested without being stored    |
| `stderr_sha256`  | string            | Hash of the oracle's stderr                                              |
| `base_sha`       | string            | Commit the task forked from                                              |
| `tree_sha`       | string            | Git tree the oracle ran against                                          |
| `verdict`        | `"pass"`          | Always `pass` — failed verifications write no receipt                    |
| `verified_at`    | string            | ISO timestamp                                                            |
| `allow`          | string[] (v2)     | The task's audited TDD-gate exemptions; empty when none                  |

The `allow` field closes the loop on the gate's only escape hatch
([hooks.md](hooks.md)): every exemption a task used is part of its permanent
record.

### Note on `plugin_version`

The field is named for the plugin distribution sddx used to ship as. That
distribution is retired and the value is now read from `package.json`, the
single version source — but **the key keeps its name on purpose.** Receipts are
immutable and hash-chained: renaming a field would change the bytes every
historical receipt is hashed over, breaking `sddx audit` at the version
boundary and invalidating chains that are otherwise perfectly sound. Treat it
as a wire-format name, not a statement about where the number comes from.

The `env.runtime` field is subject to the same rule. It records `bun` for
anything sddx writes today, and `unknown` in the unreachable case where Bun is
somehow absent; `node` is still *accepted* by the validator so that receipts
written before Bun became the only supported runtime keep validating, but
nothing writes it any more.

## Receipt v3 (sddx ≥ 0.2)

v3 replaces the single run record (`exit_code`, `duration_ms`,
`stdout_sha256`, `stderr_sha256`) with `runs: []` — one entry per oracle
execution, each carrying those same four fields; a pass requires every entry
to exit 0. It adds `env` (`os`, `arch`, `runtime`, `runtime_version`,
`dirty_tree` — whether the oracle ran against uncommitted changes) and
optional `signature`/`signer` (see
[verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md#enable-receipt-signing)).
`sddx audit` accepts v1–v3; existing chains stay valid.

## The hash chain

Each receipt's `prev` is the sha256 of its parent receipt **file** (the exact
bytes on disk), and the first receipt links to `"genesis"` with `seq` 1.
Editing any receipt changes its file hash, which orphans every descendant —
tampering is loud, not silent.

Strictly, receipts form a hash **tree** rooted at genesis: parallel worktrees
legitimately write sibling receipts sharing one parent, so validation requires
every `prev` to match the file hash of a receipt with strictly smaller `seq`.
The linear chain is just the sequential special case.

## What audit checks

`sddx audit` re-walks the whole receipts directory:

1. **Schema** — every receipt has every required field, valid
   (`<field>: missing or invalid` per violation).
2. **Chain integrity** — every `prev` resolves to an existing receipt's file
   hash; genesis receipts have `seq` 1; children outnumber their parents'
   `seq`.
3. **Commit binding** — each receipt file was introduced by a commit, and its
   working-tree bytes match the committed bytes. A receipt that exists only in
   the working tree is unverifiable and flagged.
4. **Signatures** (`--signatures`) — the commit that introduced each receipt
   carries a valid signature, when you have commit signing configured.

Exit 1 on any finding, 0 on a clean chain — safe to wire into CI (see
[verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md#wire-audit-into-ci)).

## Findings and remediation

| Finding                                                             | Meaning                                                       | What to do                                                                     |
| --------------------------------------------------------------------| --------------------------------------------------------------| --------------------------------------------------------------------------------|
| `chain: <file>: prev hash matches no receipt — chain broken (tampered or deleted)` | A parent receipt was edited or removed          | Restore the original bytes from git history (`git checkout <sha> -- <file>`)   |
| `chain: <file>: genesis-linked receipt must have seq 1, got <n>`    | The chain root was rewritten                                  | Restore from history; a legitimate root always has seq 1                       |
| `chain: <file>: seq <n> must exceed parent seq <m>`                 | Sequence numbers were manipulated                             | Restore from history                                                           |
| `chain: <file>: <field>: missing or invalid`                        | Receipt edited into an invalid shape                          | Restore from history                                                           |
| `<file>: committed receipt missing from working tree — receipt deleted` | A committed receipt was deleted locally                   | `git checkout -- .sddx/receipts/` to restore it                                |
| `<file>: working tree differs from committed state — receipt bytes tampered` | Local edits to a committed receipt               | Restore the committed bytes; receipts are immutable                            |
| `<file>: not bound to any commit — an uncommitted receipt is unverifiable` | Receipt never committed (interrupted verify?)      | Commit it if legitimate, or delete and re-run `sddx verify`                    |
| `<file>: commit binding failed: <err>`                              | Git couldn't answer which commit introduced the file          | Check repository health (shallow clone? rewritten history?)                    |
| `<file>: binding commit <sha> has no valid signature`               | `--signatures` only: introducing commit unsigned/invalid      | Expected if signing isn't configured; otherwise investigate the commit         |

If a finding survives restoration attempts, treat the receipt as untrusted and
re-verify the task: the code may be fine, but its proof is gone.

## v4 — approval provenance

Version 4 adds an optional `approval` object, present for any task belonging to
a goal and absent for a standalone task:

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `human \| auto` | The mode that actually applied |
| `authorization` | `human-approval \| auto` | Whether a person approved this plan or the configured mode authorized it. Absent on receipts written before it was recorded |
| `requested_mode` | `human \| auto` | **Legacy, read-only.** Written when `auto` degraded to `human`; bounds are hard refusals now, so nothing writes it |
| `degraded_reason` | string | **Legacy, read-only** — see `requested_mode` |
| `plan_sha256` | hex64 | The approved plan this work descends from |
| `at` | ISO-8601 | When the plan was approved |
| `assumptions` | string[] | Decisions resolved without asking, from the spec |
| `amendments` | `[]` | Reserved; always empty in this version |

`assumptions` is denormalized onto the receipt deliberately — a receipt that
needs another file to be interpreted stops being a receipt.

Versions 1–3 remain valid and MUST NOT carry an `approval` block; a pre-v4
receipt containing one is a finding.

`sddx audit` cross-checks a receipt's `approval` against its goal and reports any
disagreement in `mode` or `plan_sha256` — **but only where the goal record is
present.** The record lives in `refs/sddx/goals/<goal-id>`, which a clone does
not fetch by default (`sddx pr create` pushes it alongside the run branch, and
a reviewer fetches it with
`git fetch origin 'refs/sddx/goals/*:refs/sddx/goals/*'`). Where it is absent —
a fresh clone that never fetched it, or CI — there is nothing to compare
against; the audit emits a note saying the provenance was *not* cross-checked
rather than passing silently. Treat a receipt's `approval` block as
self-reported unless you see that cross-check confirmed.

**What this proves:** which plan a receipt descends from and which mode it ran
under. **Not** who approved it — see
[interaction-modes.md](../explanation/interaction-modes.md#what-sddx-can-and-cannot-prove).

## v5: boundary proof, review and approval binding

Written by sddx 6. Everything from v4 stays, with three changes in meaning:
`runs` holds the GREEN half of the boundary proof, `approval` is always present
(every v6 task belongs to a goal), and `harness`/`model` are the values passed
to `review record`, as reported. Every new field is required; a v5 receipt
without its proof or its review would claim a completion it cannot show.

| Field | Type | Meaning |
| --- | --- | --- |
| `spec` | `{path, goal_id}` | The goal spec the task came from |
| `boundary.base_sha` | hex40 | The commit the task forked from |
| `boundary.tree_sha` | hex40 | The verified tree: the worktree's content outside `.sddx/` when `verify` passed |
| `boundary.test_files` | string[] | Changed test files applied in the RED half |
| `boundary.red` | `{exit_code, stdout_sha256, stderr_sha256}` | The oracle's run on the base commit plus those test files; it had to fail |
| `review` | `{verdict, diff_sha256, reviewer, findings_sha256?, at}` | The passing review; `diff_sha256` is the sha256 of `git diff --binary <base> <verified tree>` |
| `profile` | `default \| strict` | The profile the task was gated under |
| `strict_runs` | `{test_exit, source, at}[]` | Strict only: the per-edit test runs the hooks or `task phase` recorded |
| `approval.binding` | `signed \| unsigned` | `signed` only when the approval token's `sddx-approval` signature verified at finalize time |
| `approval.signature`, `approval.signer` | string | Present exactly when `binding` is `signed`: the token's signature, carried so a clone without the token can check it |
| `approval.harness_reported` | string | The harness passed to `plan approve --harness`, as reported |

Top-level `tree_sha` is the verified tree plus the task's state file, which is
the committed tree minus the receipt itself; `boundary.tree_sha` is the code
that was proven and reviewed. The finalize commit differs from
`boundary.tree_sha` in exactly two files, `.sddx/tasks/<id>.json` and
`.sddx/receipts/<id>.json`.

<!-- receipt-example: v5 -->
```json
{
  "version": 5,
  "task_id": "h-1",
  "seq": 1,
  "prev": "genesis",
  "harness": "claude-code",
  "model": null,
  "plugin_version": "6.0.0",
  "oracle": { "run": "bun test tests/health.test.ts", "expect": "exit 0" },
  "runs": [
    {
      "exit_code": 0,
      "duration_ms": 11,
      "stdout_sha256": "6043908c8d26d62698476b88f737f39d5d3e91008d4155a81730902f5a37479c",
      "stderr_sha256": "e12f6a3653d952370da3db742dcc2e1971062511664d6ef72cf84d281ccba817"
    }
  ],
  "env": { "os": "linux", "arch": "x64", "runtime": "bun", "runtime_version": "1.3.12", "dirty_tree": true },
  "base_sha": "fabb01be13efa41fb9ccafcb0956560b39261fe6",
  "tree_sha": "8384853a5fdd8b72e9b16c33e8d76936cf04c72a",
  "verdict": "pass",
  "verified_at": "2026-10-26T16:08:57.866Z",
  "allow": [],
  "approval": {
    "mode": "human",
    "authorization": "human-approval",
    "plan_sha256": "2b36966e66162c14fbaabbfc03a0c5e8de2e43476fbf546acda3a759498f83fa",
    "at": "2026-10-26T16:08:50.954Z",
    "assumptions": [],
    "amendments": [],
    "binding": "unsigned",
    "harness_reported": "claude-code"
  },
  "spec": { "path": ".sddx/specs/2026-10-26-health.md", "goal_id": "2026-10-26-health" },
  "boundary": {
    "base_sha": "fabb01be13efa41fb9ccafcb0956560b39261fe6",
    "tree_sha": "efcc693d554a48ba6eacfd3c9def98419000b5c3",
    "test_files": ["tests/health.test.ts"],
    "red": {
      "exit_code": 1,
      "stdout_sha256": "6043908c8d26d62698476b88f737f39d5d3e91008d4155a81730902f5a37479c",
      "stderr_sha256": "2b1699e1bbe0b4e0e3dc664a26cb4a2849621bbde6e04feb7e37a463279e5d90"
    }
  },
  "review": {
    "verdict": "pass",
    "diff_sha256": "3432cca02fe48b965c65fcf172fd75cc1609e8f5cb431917fef3dc13df6f5ac2",
    "reviewer": "critic",
    "at": "2026-10-26T16:08:58.033Z"
  },
  "profile": "default"
}
```

### What `sddx audit` says about a v5 receipt

Audit keeps to what the receipt can actually show:

- **Human approval** is reported as provable only when `binding` is `signed` and
  the signature the receipt carries verifies against
  `gpg.ssh.allowedSignersFile`; the signer is named. The approval token itself
  is not needed, so this works in a fresh clone or CI. Without an allowed-signers
  file the signature cannot be checked, which is a note ("not provable"), not a
  finding. An `unsigned` binding is reported as "human approval not provable". A
  `signed` claim whose signature does not verify is a finding.
- **The harness** is shown as "reported, not verified".
- **The review** is shown as "a recorded review, not a verified one", with the
  reviewer as reported and the diff it covered. sddx proves the review covered
  exactly the merged diff, never that the review was good.
