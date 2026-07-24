# Example: branch mode

Part 1: forcing `--workspace branch` — a dependent materializes as a branch,
not a worktree. Part 2: `auto` downgrading to branch mode by itself, the
moment it detects a submodule.

## Setup

```sh skip
bash examples/05-branch-mode/setup.sh
```

`cd` into the printed directory before running anything below.

## Part 1: explicit branch mode with a dependent

```sh
ROOT="$PWD"
mkdir -p specs
cat > specs/a.yaml <<'EOF'
task: branch mode root a
success_criteria:
  - "a.done exists"
oracle:
  type: command
  run: "test -f a.done"
  expect: exit 0
scope:
  - "src/a/**"
EOF
cat > specs/b.yaml <<'EOF'
task: branch mode child b
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/a/child.ts"
EOF
cat > graph.yaml <<'EOF'
goal: ship on branches
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
    depends_on: a
EOF
```

```sh
OUT=$(./sddx graph create --graph graph.yaml --workspace branch)
echo "$OUT"
A_ID=$(echo "$OUT" | grep -E '^ *a →' | awk '{print $3}')
B_ID=$(echo "$OUT" | grep -E '^ *b →' | awk '{print $3}')
```

Branch mode leaves `HEAD` on the root's own branch in the main checkout — no
worktree at all:

```sh
test ! -d "$ROOT/.sddx-worktrees/$A_ID"
git rev-parse --abbrev-ref HEAD | grep -q "sddx/$A_ID"
```

```sh
./sddx task phase "$A_ID" RED --test-exit 1
./sddx red-check "$A_ID"
touch a.done
./sddx task phase "$A_ID" GREEN --test-exit 0
./sddx task phase "$A_ID" VERIFY
./sddx verify "$A_ID"
```

```sh
./sddx task materialize "$B_ID"
```

`b` materializes as a branch at the same commit as `a`'s — still no
worktree:

```sh
[ "$(git rev-parse "sddx/$B_ID")" = "$(git rev-parse "sddx/$A_ID")" ]
test ! -d "$ROOT/.sddx-worktrees/$B_ID"
```

## Part 2: auto downgrades on its own when it sees a submodule

```sh
git checkout -q main
mkdir vendor-src
cd vendor-src
git init -q -b main
git config user.email "example@sddx.invalid"
git config user.name "sddx example"
git config commit.gpgsign false
git commit -q --allow-empty -m init
cd "$ROOT"
git -c protocol.file.allow=always submodule add -q ./vendor-src vendor
git commit -q -m "add vendor submodule"
```

(`-c protocol.file.allow=always` is required by git ≥ 2.38.1's fix for
CVE-2022-39253 — local `file://`/relative-path submodules are refused by
default. This override is safe here: `vendor-src` is a throwaway repo this
same script just created.)

```sh
cat > spec2.yaml <<'EOF'
task: task in a repo with submodules
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
EOF
```

```sh
./sddx task create --spec spec2.yaml --workspace auto 2>&1 | grep -q "submodules detected"
```

Worktrees crossing submodule boundaries are unsafe, so `auto` falls back to a
sequential `sddx/<id>` branch — this is expected behavior, not an error; the
task runs the same loop, just not in parallel isolation.
