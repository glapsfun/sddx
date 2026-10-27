# Migrate to sddx 6

sddx 6 keeps what made sddx 5 trustworthy (executable oracles, approval bound to
a plan hash, one worktree per task, hash-chained receipts) and changes almost
everything around it. This guide moves a repository that sddx 5 set up.

## What changes for you

| sddx 5 | sddx 6 |
| --- | --- |
| `npm install -g @glapsfun/sddx` then `sddx init --adapter claude`, which generated `.claude/` files | install the sddx plugin for your harness; nothing is generated into the repository |
| a graph YAML plus one spec YAML per task in `.sddx/drafts/` | one markdown spec per goal in `.sddx/specs/<date>-<slug>.md` ([spec-reference.md](../reference/spec-reference.md)) |
| `sddx graph create --dry-run`, `graph approve`, `graph create` | `sddx plan check`, `plan approve`, `plan start` |
| phases PLAN, RED, GREEN, REFACTOR, VERIFY, DONE | states PLANNED, IN_PROGRESS, IN_REVIEW, DONE, ABANDONED |
| `task phase`, `red-check`, the TDD hook on every edit | `sddx verify` proves red then green at the boundary in every profile; the per-edit hooks are the opt-in `strict` profile ([hooks.md](../reference/hooks.md)) |
| `verify` wrote the receipt | `verify` moves the task to `IN_REVIEW`; `review record --verdict pass` writes the receipt |
| receipt version 4 | receipt version 5; the chain continues from your last v4 receipt |
| `runtime_scope`, `package_manager`, `adapters` in config | removed; `profile` added |

Receipts, approval tokens and goal records are history and stay where they are.
`sddx audit` validates versions 1 to 5 in one chain.

## 1. Finish or close in-flight work with sddx 5

Migration refuses while any sddx 5 task is unfinished or any sddx 5 goal has
outstanding tasks, because moving the state out from under it would strand the
work. `sddx migrate` lists each one. Finish them with sddx 5, or close them out:

```sh skip
npx @glapsfun/sddx@5 task phase <task-id> ABANDONED
```

## 2. Preview

```sh
sddx migrate
```

This writes nothing. It lists every action: sddx 5 files under `.claude/` it
will remove (only files whose content matches what sddx 5 generated, checked
against your local install record or a frozen table of every file 5.0.0 could
write), files it will keep because you edited them, the sddx hook entries it
will take out of `.claude/settings.json` (your own hooks stay), the v5 state it
will move to `.sddx/legacy/`, and the config rewrite.

## 3. Apply

```sh
sddx migrate --yes
```

It does not commit. Commit the result as one commit, so a single `git revert`
undoes it:

```sh
git add -A .sddx .claude
git commit -qm "chore: migrate sddx 5 to 6"
```

## 4. Check

```sh
sddx audit
```

```sh
sddx doctor
```

`audit` should report the chain intact, and `doctor` should show no
`v5-leftovers`. Files migration kept because you edited them are listed in the
preview; remove them by hand when you are ready.

## 5. Install the plugin

Install the sddx plugin for your harness and remove the old global package if
your scripts no longer need it. If `package.json` lists `@glapsfun/sddx` as a
dependency, upgrade or remove it yourself: migration never edits package
manifests.

## Going back

Before you commit, `git checkout -- .` and `git clean` restore everything. After
you commit, `git revert` the migration commit and pin `@glapsfun/sddx@5`.
