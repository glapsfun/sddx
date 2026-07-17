# Releasing sddx

Semver, with `plugin.json`, `package.json`, and `marketplace.json` metadata in
lockstep; every release is tagged `v<version>`.

## Checklist

1. **Update the changelog** — move the `## [Unreleased]` entries in
   `CHANGELOG.md` under a new `## [<version>] - <today's date>` heading.
2. **Bump versions** — `.claude-plugin/plugin.json`, `package.json`, and the
   `metadata.version` in `.claude-plugin/marketplace.json` all carry the same
   `<version>`.
3. **Full local gate** — `bun run check` and `pre-commit run --all-files` are
   green; `dist/` is rebuilt and committed (CI fails on drift).
4. **Clean-clone validation** — on a fresh clone (not the working checkout,
   which carries a gitignored CLAUDE.md that fails strict mode):
   `claude plugin validate --strict <clone>` passes, covering both
   `plugin.json` and `marketplace.json`.
5. **Tag and push** — `git tag v<version>` on the release commit;
   `git push origin main --tags`.
6. **Clean-machine install smoke test (blocking, manual)** — on a machine or
   container without a prior sddx install:
   `claude plugin marketplace add glapsfun/sddx` →
   `claude plugin install sddx@sddx` → run the README quickstart end to end:
   task completes under the hook gates, `sddx board` renders, `sddx audit`
   exits 0. Do not announce the release before this passes.
7. **Submit for indexing** — skills.sh and directory aggregators (manual,
   per-site submission; link the tagged release).

## Notes

- sddx makes zero network calls; nothing in a release changes that. Any new
  dependency or network primitive fails `tests/privacy.test.ts`.
- Receipts written by older versions stay valid: the audit accepts all schema
  versions the validator knows (`version` 1 and 2 as of 0.1.0). Never ship a
  change that invalidates existing chains.
