# Receipt schema

One JSON file per task at `.sddx/receipts/<task-id>.json`, written exactly
once by the verifier — and only on a passing oracle. A failed verification
writes nothing; there are no failure receipts, so `verdict` is always
`"pass"`.

| Field            | Type              | Meaning                                                                  |
| ---------------- | ----------------- | ------------------------------------------------------------------------ |
| `version`        | `1 \| 2 \| 3 \| 4` | Receipt schema; v2 added `allow`, v3 added `runs`/`env`, v4 added `approval` |
| `task_id`        | string            | The task this receipt settles                                            |
| `seq`            | number            | Position in the chain; strictly greater than the parent's                |
| `prev`           | string            | sha256 of the parent receipt *file*, or `"genesis"` for the first        |
| `harness`        | string            | Harness that ran the loop (e.g. `claude-code`)                           |
| `model`          | string \| null    | Model provenance, when known                                             |
| `plugin_version` | string            | sddx version that wrote the receipt                                      |
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
