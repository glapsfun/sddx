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
        │
        ▼
release workflow checks out that tag (no rebuild — dist/cli.mjs is
already committed and CI-verified) and runs `npm publish --provenance`
— authenticated via npm OIDC trusted publishing, no stored NPM_TOKEN
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
4. **Merge when ready.** That's it: merging tags `v<version>`, publishes
   the GitHub Release, and publishes the same version to npm as
   `@glapsfun/sddx` — all automatic, no separate manual step after the
   merge. Treat merging the release PR as publishing, not proposing to
   publish.
5. **Submit for indexing** (still manual): skills.sh and directory
   aggregators, per-site submission, linking the tagged release.

## npm publish (one-time setup)

The package is published as `@glapsfun/sddx` (the `glapsfun` npm org),
authenticated via npm's OIDC **trusted publishing** — no long-lived
`NPM_TOKEN` secret stored anywhere. The bare name `sddx` is rejected by npm's
package-name-similarity policy (too close to existing packages), and scoping
under `@glapsfun` also lets `publishConfig.access: "public"` in `package.json`
handle the "public, not private-scoped-package" requirement automatically —
no `--access public` flag needed on any publish, bootstrap or CI. Because a
package's trusted publisher can only be configured from its registry
settings page, and that page only exists once the package has been published
at least once, the very first publish is a manual, one-time bootstrap:

1. From a clean local checkout, `bun run build && CI=true npm publish` using
   a maintainer's own npm login/token with publish rights on the `glapsfun`
   org, to claim `@glapsfun/sddx`. Discard/revoke a token afterward if one
   was used — it is not needed again. (`CI=true` is required:
   `prepublishOnly` refuses to publish outside CI to guard against an
   accidental local `npm publish` once `package.json` is no longer
   `private`; GitHub Actions sets this automatically, so ongoing releases
   don't need it.)
2. On npmjs.com, open the `@glapsfun/sddx` package's settings and add a
   trusted publisher: `glapsfun/sddx`, bound to the exact release workflow
   file that runs `npm publish`.
3. From then on, every release publishes automatically via OIDC — no token,
   no manual step. `sddx --version` after a release should match the tag.

## What's still not automated

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
