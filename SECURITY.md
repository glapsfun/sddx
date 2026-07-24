# Security policy

## Design

sddx is built to have a minimal attack surface:

- **Zero network calls.** The plugin never talks to the network — no
  telemetry, no update checks, no remote fetches. This is enforced by
  `tests/privacy.test.ts`, which fails on any network primitive or new
  dependency.
- **No runtime dependencies.** The shipped `dist/*.mjs` bundles are
  dependency-free single files; there is no supply chain to compromise at
  runtime. npm packages exist only at build time.
- **Local state only.** All state is plain files under `.sddx/` in your own
  repository, plus local git operations.
- **Tamper-evident records.** Receipts are hash-chained; `sddx audit` detects
  any edited or deleted receipt. See
  [docs/reference/receipts-schema.md](docs/reference/receipts-schema.md).

## Reporting a vulnerability

Report vulnerabilities privately via GitHub's security advisories:
<https://github.com/glapsfun/sddx/security/advisories/new>. Please do not open
a public issue for a security problem.

You can expect an acknowledgment within a week. There is no bounty program.
