# Contributing to sddx

Thanks for helping build sddx. This page is the complete dev setup and the
gates your change has to clear. For a map of the codebase, start with
[docs/explanation/architecture.md](docs/explanation/architecture.md).

## Prerequisites

- [Bun](https://bun.sh) — the exact version is pinned in `.bun-version`.
- [pre-commit](https://pre-commit.com) — `brew install pre-commit` (or `pipx
  install pre-commit`).

## One-time setup

```sh
bun install
pre-commit install --install-hooks
```

That installs both hook stages:

- **on `git commit`** — fast hygiene (whitespace, EOF, merge markers, large
  files, JSON/YAML syntax, yamllint) and Biome lint.
- **on `git push`** — typecheck and the full test suite.

## Everyday commands

| Command            | What it does                               |
| ------------------ | ------------------------------------------ |
| `bun run lint`     | Biome lint + format check (TS/JS/JSON)     |
| `bun run lint:fix` | Auto-fix lint and formatting issues        |
| `bun test`         | Run the test suite                         |
| `bun run check`    | Full gate: lint → typecheck → test → build |

CI runs the same gates (`pre-commit run --all-files` plus typecheck, tests,
build, dist drift check, docs link check, and strict plugin validation), so a
clean local `bun run check` and pre-commit pass means CI will agree.

## Pull request expectations

- **Keep PRs small and single-purpose** — one behavior change per PR.
- **Behavior changes come with tests.** The project practices what it
  enforces: test first, then implementation.
- **Rebuild `dist/` when `src/` changes** — `bun run build` and commit the
  bundles; CI fails on drift between `src/` and `dist/`.
- **Zero network calls is a hard invariant.** Any new dependency or network
  primitive fails `tests/privacy.test.ts`; don't add one.
- **Hooks stay fast.** The SessionStart path budgets < 200 ms; keep heavy
  imports off the hook hot path.
- Update the relevant `docs/` page in the same PR as the behavior it
  describes.
- **Commit messages use conventional-commit type prefixes** (`feat:`, `fix:`,
  `docs:`, `ci:`, `chore:`, `refactor:`, `test:`, ...) — they drive the
  automated release's version bump and changelog, so a clear, correctly typed
  commit message *is* the changelog entry. Don't hand-edit `CHANGELOG.md`'s
  `[Unreleased]` section; release-please generates it at release time.

## Releases

Releases are automated: [release-please](https://github.com/googleapis/release-please)
proposes each release as a pull request, computed from conventional-commit
messages (`feat:`, `fix:`, `docs:`, `ci:`, ...) — the style already used
throughout this repo's history. A maintainer's job is to review/edit that PR's
changelog section and merge it once the required checks (including an
automated clean-checkout install smoke test) are green; merging *is* the
release. See [docs/RELEASING.md](docs/RELEASING.md) for the full flow.
