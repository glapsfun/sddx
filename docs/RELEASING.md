# Releasing sddx

Semver, with `plugin.json`, `package.json`, and `marketplace.json` metadata in
lockstep; every release is tagged `v<version>`. The process is automated by
[release-please](https://github.com/googleapis/release-please): a bot proposes
each release as a pull request, and merging that PR is the release.

## How it works

```
PR merges to main (conventional commits: feat:, fix:, docs:, ci:, ...)
        │
        ▼
release-please opens/updates a standing "chore: release vX.Y.Z" PR
  • new CHANGELOG.md section drafted from the commits since the last release
  • plugin.json, package.json, marketplace.json#metadata.version bumped together
        │
        ▼
required checks run on that PR, including the clean-checkout install
smoke test (.github/workflows/release-smoke-test.yml) — a fresh runner
installs the plugin, drives the README quickstart, and asserts
`sddx board` / `sddx audit` both exit 0
        │
        ▼
maintainer reviews/edits the changelog section, merges when green
        │
        ▼
release-please tags v<version> and publishes the GitHub Release
```

## The maintainer's job

1. **Write conventional commits.** Version bumps and changelog sections are
   computed from commit type prefixes (`feat:` → Added, `fix:` → Fixed, a
   breaking-change marker → major bump). This is already the repo's de facto
   style; nothing new to learn.
2. **Review the release PR when it appears.** release-please keeps a single
   standing PR up to date as commits land on `main`. Read the generated
   `CHANGELOG.md` section and edit it for clarity/voice if the auto-generated
   wording undersells what shipped — the PR stays open for editing until you
   merge it.
3. **Wait for the required checks**, including the install smoke test. It
   can't be skipped or bypassed by memory — merge is blocked until it's green.
4. **Merge when ready.** That's it: merging tags `v<version>` and publishes
   the GitHub Release automatically. There is no separate manual step after
   the merge — treat merging the release PR as publishing, not proposing to
   publish.
5. **Submit for indexing** (still manual): skills.sh and directory
   aggregators, per-site submission, linking the tagged release.

## What's still not automated

- **npm / package registry publish** — not applicable; `package.json` is
  `private: true` and nothing in this project is published there. Scope is
  GitHub Release only.
- **skills.sh / directory aggregator submission** — manual, out of band.
- **Commit message enforcement** — conventional-commit types drive the
  automation, but nothing currently blocks a malformed commit message at
  commit time. The existing history follows the convention consistently
  without enforcement; a `commit-msg` pre-commit stage (commitlint) is a
  natural fast-follow if drift becomes a problem.

## Notes

- sddx makes zero network calls at runtime; nothing in a release changes
  that — this automation is CI/CD tooling, not part of the shipped plugin.
  Any new dependency or network primitive in the plugin itself still fails
  `tests/privacy.test.ts`.
- Receipts written by older versions stay valid: the audit accepts all
  schema versions the validator knows. Never ship a change that invalidates
  existing chains.
- The install smoke test is the automated replacement for the old
  "blocking (manual) clean-machine install test": a CI runner is a clean
  machine on every run, so the check that used to depend on someone
  remembering to run it by hand is now a required status check instead.
