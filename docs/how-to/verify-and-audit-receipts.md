# Verify and audit receipts

How to inspect a task's receipt by hand, run `sddx audit` locally and in CI,
and turn on commit/receipt signing. Field-by-field schema lives in
[receipts-schema.md](../reference/receipts-schema.md); a full runnable
walkthrough — including deliberately tampering with a receipt and watching
audit catch it — is in
[examples/07-receipts-and-audit](../../examples/07-receipts-and-audit/).

## Inspect a receipt

Every settled task has exactly one receipt file:

```sh
cat .sddx/receipts/<task-id>.json
```

Pull a single field without a JSON tool (sddx ships no runtime dependencies,
so examples avoid assuming `jq` is installed):

```sh
grep -o '"verdict": "[^"]*"' .sddx/receipts/<task-id>.json
```

## Run audit locally

```sh
sddx audit
```

Prints `audit: <n> receipt(s) verified, chain intact` and exits 0 on a clean
chain, or one `chain: …`/`<file>: …` line per finding on stderr and exits 1 —
see [receipts-schema.md](../reference/receipts-schema.md#findings-and-remediation)
for what each finding means and how to fix it. Add `--signatures` to also
verify the commit that introduced each receipt is signed.

## Wire audit into CI

`sddx audit --ci` exits non-zero **only on tamper evidence**: a broken
receipt hash chain; edited, deleted, uncommitted, or schema-invalid receipts;
or a task marked `DONE` without a receipt. A repo or PR with no sddx activity
passes clean — safe to add to any repository; sddx stays opt-in per task.

Zero-install workflow (the committed `dist/` bundle needs no npm install):

```yaml
name: sddx-audit
on: pull_request
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # audit binds receipts to their introducing commits
      - uses: actions/checkout@v4
        with:
          repository: glapsfun/sddx
          ref: v0.2.0
          path: .sddx-tool
      - run: node .sddx-tool/dist/cli.mjs audit --ci
```

## Enable commit signing

When you have git commit signing (SSH or GPG) configured, sddx's atomic task
commits are signed like any other commit, and `sddx audit --signatures`
verifies them. Signing adds **identity** on top; chain **integrity** is
independent of it — an unsigned repository still gets full tamper-evidence
from the hash tree.

## Enable receipt signing

When the repo has SSH commit signing configured (`gpg.format ssh` +
`user.signingkey` as a key path), `sddx verify` also signs each receipt:
`signature` is an SSH signature (namespace `sddx-receipt`) over the sha256 of
the receipt's unsigned bytes; `signer` is the git `user.email`. `sddx audit`
verifies embedded signatures against `gpg.ssh.allowedSignersFile`: invalid →
audit fails; unsigned or unverifiable → informational only (`--signatures`
prints the notes). Identity sits on top; chain integrity never depends on it.
