---
name: audit
description: Verify the receipt hash chain, commit bindings, and (optionally) commit signatures. Use when the user asks to audit sddx receipts or check the integrity of completed work.
---

# /sddx:audit

CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/sddx-run" "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"` (run from the repo root).

Run: `... audit` — add `--signatures` only if the user asks for signature
verification (requires the repo to use git commit signing).

Exit 0 → report "N receipt(s) verified, chain intact". Exit 1 → present each
finding with its remediation:

- **chain: … prev hash matches no receipt / seq gap** — a receipt was edited
  or deleted. Recover the original bytes from git history
  (`git log --all -- .sddx/receipts/<id>.json`); the chain is only valid with
  the exact original files.
- **not bound to any commit** — the receipt was never committed. Commit it
  (receipts are part of the task's atomic commit); an uncommitted receipt
  proves nothing.
- **working tree differs from committed state** — local tampering. Restore
  with `git restore .sddx/receipts/<id>.json`.
- **binding commit has no valid signature** — only reported under
  `--signatures`. Either signing isn't configured (drop the flag) or the
  commit is genuinely unsigned — escalate to the user; do not re-sign
  history yourself.
- **approval mode / plan hash disagrees with its goal** — a receipt's recorded
  provenance no longer matches the goal it belongs to. Restore the receipt from
  git; do not "reconcile" it by editing either file.
- **approval signature is invalid** — the token's signature does not match the
  plan hash it claims. Escalate; never re-sign.
- **approval token is unreadable / hash does not match its name** — treat the
  plan as unapproved and re-approve it deliberately.

## What an approval audit does and does not prove

Report this accurately. A clean approval result establishes **which plan** each
receipt descends from, **which mode** it ran under, and — where a signature is
present and valid — that it was produced by the named signer's key. It does
**not** establish that a particular human approved anything: any caller can
write an unsigned token, and only a touch-required hardware key makes signing an
act a model's own shell cannot perform. Say "plan X, mode Y", never "approved by
a human", unless the user has told you a touch-required key is in use.

A receipt recording `mode: auto` is a permanent, honest marker that no human saw
that plan. Surface it; it is information, not a finding.

Watch for the note `NOT cross-checked (its goal file is absent…)`. Goal state is
local-only and never committed, so in a clone or CI the receipt's `approval` is
self-reported and nothing verified it. Relay that plainly rather than reporting a
clean approval audit.

Never "fix" findings by editing or regenerating receipts — they are
write-once. Report, restore from git, or escalate.
