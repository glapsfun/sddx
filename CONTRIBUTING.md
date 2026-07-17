# Contributing to sddx

Thanks for helping build sddx. This page is the complete dev setup and the
gates your change has to clear. For a map of the codebase, start with
[docs/architecture.md](docs/architecture.md).

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
  describes, and add a line to `CHANGELOG.md` under `## [Unreleased]`.

## Releases

Maintainers follow the checklist in [docs/RELEASING.md](docs/RELEASING.md).
