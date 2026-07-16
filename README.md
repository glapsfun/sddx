# sddx

## Development

Prerequisites: [Bun](https://bun.sh) (version pinned in `.bun-version`) and
[pre-commit](https://pre-commit.com) (`brew install pre-commit`).

One-time setup after cloning:

```sh
bun install
pre-commit install --install-hooks
```

That installs both hook stages: fast hygiene + lint checks on `git commit`,
typecheck + tests on `git push`.

Everyday commands:

| Command            | What it does                               |
| ------------------ | ------------------------------------------ |
| `bun run lint`     | Biome lint + format check (TS/JS/JSON)     |
| `bun run lint:fix` | Auto-fix lint and formatting issues        |
| `bun test`         | Run the test suite                         |
| `bun run check`    | Full gate: lint → typecheck → test → build |

CI runs the same gates (`pre-commit run --all-files` plus typecheck, tests,
build, dist drift check, and strict plugin validation), so a clean local
`bun run check` and pre-commit pass means CI will agree.
