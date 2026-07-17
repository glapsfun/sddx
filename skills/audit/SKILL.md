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

Never "fix" findings by editing or regenerating receipts — they are
write-once. Report, restore from git, or escalate.
