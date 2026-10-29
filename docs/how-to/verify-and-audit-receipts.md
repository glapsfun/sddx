# Verify and audit receipts

How to inspect a task's receipt, run `sddx audit` locally and in CI, and sign
commits, receipts and approvals. The field-by-field schema is in
[the receipts schema](../reference/receipts-schema.md). A runnable walkthrough,
including tampering with a receipt and watching audit catch it, is
[examples/07-receipts-and-audit](../../examples/07-receipts-and-audit/).

## Inspect a receipt

Every finished task has exactly one receipt, written when its review passed:

```sh
cat .sddx/receipts/<task-id>.json
```

It records the oracle and its GREEN runs, the boundary proof's base and test
files, the review verdict and the hash of the reviewed diff, how the plan's
approval was bound, and the hash of the previous receipt in the chain.

## Run audit locally

```sh
sddx audit
```

It prints the number of receipts verified and `chain intact`, and exits 0 on a
clean chain, or prints one line per finding and exits 1. Each finding and its
fix are listed in
[the receipts schema](../reference/receipts-schema.md#findings-and-remediation).
It also says, per receipt, whether human approval of the plan is provable.
Add `--signatures` to check that the commit introducing each receipt is signed.

Until a goal's run branch is merged, its receipts exist only on
`sddx/run-<goal-id>`. Run the audit in a checkout of that branch, as the finish
skill does, or it finds none.

## Wire audit into CI

`sddx audit --ci` exits non-zero only on tamper evidence: a broken chain, a
receipt edited, deleted, left uncommitted or schema-invalid, or a task marked
`DONE` without a receipt. A repository with no sddx activity passes, so it is
safe to add anywhere.

```yaml
name: sddx-audit
on: pull_request
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # audit binds receipts to the commits that added them
      - uses: oven-sh/setup-bun@v2
      - run: bunx @glapsfun/sddx audit --ci
```

## Sign commits

With git commit signing configured (`commit.gpgsign`, SSH or GPG), the commits
sddx makes when a review passes are signed like any other, and
`sddx audit --signatures` verifies them. Signing adds identity; the chain's
integrity does not depend on it.

## Sign receipts

With SSH signing configured (`gpg.format ssh` and `user.signingkey` as a key
path), `sddx review record` signs each receipt it writes: an SSH signature in
namespace `sddx-receipt` over the sha256 of the receipt's unsigned bytes, with
your git `user.email` as signer. `sddx audit` checks it against
`gpg.ssh.allowedSignersFile`: an invalid signature fails the audit; an unsigned
or uncheckable one is a note.

## Sign approvals

With the same setup, `sddx plan approve` signs the approval too, and the
receipt carries that signature as `approval.binding: signed`. That is the only
case in which `audit` reports human approval as provable. Use a key that needs
a touch or a passphrase if you want the signature to prove a person was
present.
