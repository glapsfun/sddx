# sddx Docs Restructure + Runnable Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize sddx's docs into a Diataxis structure (tutorials/how-to/reference/explanation) and add nine runnable `examples/` scaffolds — one per major feature — self-verified by an automated harness wired into the existing `bun test` suite.

**Architecture:** Each `examples/NN-name/` directory holds a `README.md` whose fenced ```sh blocks are both the human-facing walkthrough and the literal script a new `scripts/verify-examples.ts` harness replays against a scratch git repo. `tests/examples.e2e.test.ts` runs every example through the harness as part of the existing `test` CI job — no new CI workflow needed, since `dist/cli.mjs` is already committed to the repo.

**Tech Stack:** TypeScript on Bun (matches the existing `src/`/`scripts/`/`tests/` conventions), plain Markdown docs, POSIX `sh`/`bash` for example scripts.

## Global Constraints

- No docs-site generator — plain GitHub-rendered Markdown only (approved design, Section: Format).
- No compat stubs at old `docs/*.md` paths — same-repo reorg, no external link surface to preserve.
- `docs/RELEASING.md` is untouched.
- Every example must run **fully offline** — no network calls, no `gh`/`glab`/real git-host interaction (matches sddx's zero-network philosophy and keeps CI deterministic). Where a feature's real behavior requires network access (`sddx pr create` actually opening a PR), the example demonstrates the local, pure refusal/setup paths only and marks the network-requiring command as illustrative-only (see Task 1's `skip` fence convention).
- Every command in an example's `README.md` fenced ```sh block must be exactly what a human copy-pastes — no hidden setup the harness does that a human couldn't also do by hand.
- Every code snippet in this plan (scripts, YAML, TypeScript, Markdown fenced blocks) is complete and exact — copy it verbatim into the named file.
- Follow existing repo conventions: double-quoted strings, semicolons, Biome formatting (`biome check --write .` if unsure), `bun test` for tests, `bun run typecheck` must stay clean.
- Every task ends with `bun test` (or the narrower test file for that task) passing and a commit.

---

### Task 1: Example-verification harness

**Files:**
- Create: `scripts/verify-examples.ts`
- Test: `tests/verify-examples.test.ts`

**Interfaces:**
- Produces (used by every later example task and by Task 16's `tests/examples.e2e.test.ts`):
  - `parseReadmeBlocks(markdown: string): Block[]` where `Block = { code: string; expectExit: number }`
  - `buildScript(blocks: Block[]): string` — a bash script string
  - `discoverExamples(repoRoot: string): string[]` — sorted example directory names under `examples/` that contain a `README.md`
  - `runExample(repoRoot: string, name: string, targetDir: string): ExampleResult` where `ExampleResult = { name: string; ok: boolean; message: string }`
- Fenced-block convention every later example must follow: opening a code fence with ` ```sh ` executes that block and asserts exit 0; ` ```sh expect=N ` asserts exit `N`; ` ```sh skip ` is parsed but never executed (for commands that need real network/host auth and are shown for illustration only, e.g. Task 14's `sddx pr create`).

- [ ] **Step 1: Write the failing tests for `parseReadmeBlocks` and `buildScript`**

Create `tests/verify-examples.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScript,
  discoverExamples,
  parseReadmeBlocks,
  runExample,
} from "../scripts/verify-examples";

describe("parseReadmeBlocks", () => {
  test("extracts sh fenced blocks with default exit 0", () => {
    const md = "prose\n\n```sh\necho hi\n```\n\nmore prose\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "echo hi\n", expectExit: 0 }]);
  });

  test("reads an expect= marker for a non-zero exit", () => {
    const md = "```sh expect=1\nexit 1\n```\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "exit 1\n", expectExit: 1 }]);
  });

  test("ignores non-sh fenced blocks", () => {
    const md = "```yaml\ntask: x\n```\n```sh\necho hi\n```\n";
    expect(parseReadmeBlocks(md)).toHaveLength(1);
  });

  test("skip-marked blocks are parsed but excluded from execution", () => {
    const md = "```sh skip\nsddx pr create --goal g\n```\n```sh\necho hi\n```\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "echo hi\n", expectExit: 0 }]);
  });
});

describe("buildScript", () => {
  test("wraps each block and asserts its expected exit code", () => {
    // (exit 3) — a subshell — not a bare `exit 3`: a bare `exit` inside a
    // bash function terminates the whole script, not just the function,
    // since functions share the caller's shell (this is exactly why real
    // example blocks never call `exit` directly — only subprocesses like
    // `sddx`/`git`/`bun` do, and their exit never touches the wrapping shell).
    const script = buildScript([{ code: "(exit 3)\n", expectExit: 3 }]);
    const r = Bun.spawnSync(["bash", "-c", script]);
    expect(r.exitCode).toBe(0);
  });

  test("fails loudly when a block's exit code doesn't match", () => {
    const script = buildScript([{ code: "(exit 0)\n", expectExit: 1 }]);
    const r = Bun.spawnSync(["bash", "-c", script]);
    expect(r.exitCode).toBe(1);
    expect(new TextDecoder().decode(r.stderr)).toContain("expected exit 1, got 0");
  });

  test("later blocks see state (cwd, variables) set by earlier ones", () => {
    const script = buildScript([
      { code: "mkdir sub && cd sub && export X=hi\n", expectExit: 0 },
      { code: '[ "$(basename "$PWD")" = sub ] && [ "$X" = hi ]\n', expectExit: 0 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "sddx-buildscript-"));
    const r = Bun.spawnSync(["bash", "-c", script], { cwd: dir });
    expect(r.exitCode).toBe(0);
  });
});

describe("discoverExamples", () => {
  test("lists example directories that carry a README.md, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-discover-"));
    mkdirSync(join(root, "examples", "02-b"), { recursive: true });
    mkdirSync(join(root, "examples", "01-a"), { recursive: true });
    writeFileSync(join(root, "examples", "02-b", "README.md"), "# b\n");
    writeFileSync(join(root, "examples", "01-a", "README.md"), "# a\n");
    mkdirSync(join(root, "examples", "not-an-example"), { recursive: true });
    expect(discoverExamples(root)).toEqual(["01-a", "02-b"]);
  });

  test("returns an empty list when examples/ doesn't exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-noexamples-"));
    expect(discoverExamples(root)).toEqual([]);
  });
});

describe("runExample", () => {
  function fixtureExample(root: string, name: string, readme: string, setup?: string): void {
    const dir = join(root, "examples", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), readme);
    if (setup) {
      const setupPath = join(dir, "setup.sh");
      writeFileSync(setupPath, setup);
      chmodSync(setupPath, 0o755);
    }
  }

  test("passes when every documented command exits as expected", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runok-"));
    fixtureExample(
      root,
      "01-ok",
      "```sh\necho hello > out.txt\n```\n```sh\ntest -f out.txt\n```\n",
    );
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "01-ok", target);
    expect(result.ok).toBe(true);
  });

  test("fails when a documented command's exit code doesn't match its marker", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runbad-"));
    fixtureExample(root, "02-bad", "```sh\ntest -f nonexistent.txt\n```\n");
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "02-bad", target);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected exit 0");
  });

  test("runs setup.sh with the target directory before replaying blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runsetup-"));
    fixtureExample(
      root,
      "03-setup",
      "```sh\ntest -f marker.txt\n```\n",
      '#!/bin/sh\ntouch "$1/marker.txt"\n',
    );
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "03-setup", target);
    expect(result.ok).toBe(true);
  });

  test("a missing example directory fails rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-missing-"));
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "99-nope", target);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/verify-examples.test.ts`
Expected: FAIL — `../scripts/verify-examples` does not exist yet (module resolution error).

- [ ] **Step 3: Implement `scripts/verify-examples.ts`**

```ts
// Replays every examples/NN-*/README.md's ```sh fenced blocks against a
// scratch git repo, so a documented command that stops working is a test
// failure, not silent doc rot. dist/cli.mjs is committed to the repo, so no
// build step is needed here — the harness runs the same bundle a real
// install would run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Block {
  code: string;
  expectExit: number;
}

export interface ExampleResult {
  name: string;
  ok: boolean;
  message: string;
}

const FENCE_RE = /```sh(?:[ \t]+(skip|expect=\d+))?\n([\s\S]*?)```/g;

export function parseReadmeBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FENCE_RE.exec(markdown);
  while (m !== null) {
    const modifier = m[1];
    const code = m[2] ?? "";
    if (modifier !== "skip") {
      const expectExit = modifier?.startsWith("expect=") ? Number(modifier.slice(7)) : 0;
      blocks.push({ code, expectExit });
    }
    m = FENCE_RE.exec(markdown);
  }
  return blocks;
}

/** Each block becomes a bash function so `cd`/exported vars persist into the
 * next block (bash functions run in the caller's shell, not a subshell) —
 * required for a walkthrough that captures a task id in one step and reuses
 * it several steps later, exactly like a human running the same commands. */
export function buildScript(blocks: Block[]): string {
  const parts = ["set -u"];
  blocks.forEach((b, i) => {
    parts.push(
      `__block_${i}() {`,
      b.code,
      "}",
      `__block_${i}`,
      `__actual_${i}=$?`,
      `if [ "$__actual_${i}" -ne "${b.expectExit}" ]; then echo "block ${i + 1}: expected exit ${b.expectExit}, got $__actual_${i}" >&2; exit 1; fi`,
    );
  });
  return parts.join("\n");
}

export function discoverExamples(repoRoot: string): string[] {
  const dir = join(repoRoot, "examples");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "README.md")))
    .sort();
}

export function runExample(repoRoot: string, name: string, targetDir: string): ExampleResult {
  const exampleDir = join(repoRoot, "examples", name);
  const readmePath = join(exampleDir, "README.md");
  if (!existsSync(readmePath)) {
    return { name, ok: false, message: `no such example: ${exampleDir}` };
  }
  const blocks = parseReadmeBlocks(readFileSync(readmePath, "utf8"));
  if (blocks.length === 0) {
    return { name, ok: false, message: "no executable ```sh blocks found in README.md" };
  }
  const setupPath = join(exampleDir, "setup.sh");
  if (existsSync(setupPath)) {
    const s = spawnSync("bash", [setupPath, targetDir], { cwd: exampleDir, encoding: "utf8" });
    if (s.status !== 0) {
      return { name, ok: false, message: `setup.sh failed: ${s.stderr || s.stdout}` };
    }
  }
  const r = spawnSync("bash", ["-c", buildScript(blocks)], { cwd: targetDir, encoding: "utf8" });
  if (r.status !== 0) {
    return { name, ok: false, message: r.stderr || r.stdout || `exit ${r.status}` };
  }
  return { name, ok: true, message: "" };
}

if (import.meta.main) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const names = discoverExamples(repoRoot);
  let failed = 0;
  for (const name of names) {
    const target = mkdtempSync(join(tmpdir(), `sddx-example-${name}-`));
    const result = runExample(repoRoot, name, target);
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${name}`);
    if (!result.ok) {
      failed += 1;
      console.error(result.message);
    }
  }
  console.log(`${names.length - failed}/${names.length} examples passed`);
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/verify-examples.test.ts`
Expected: PASS — all cases in Step 1 green.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && biome check scripts/verify-examples.ts tests/verify-examples.test.ts`
Expected: both exit 0. Fix any reported issue before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-examples.ts tests/verify-examples.test.ts
git commit -m "feat: add example-verification harness for docs/examples"
```

---

### Task 2: Docs skeleton + verbatim moves

**Files:**
- Create dirs: `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, `docs/explanation/`, `examples/`
- Move: `docs/installation.md` → `docs/how-to/install-sddx.md`
- Move: `docs/hooks.md` → `docs/reference/hooks.md`
- Move: `docs/cli.md` → `docs/reference/cli.md`
- Move: `docs/architecture.md` → `docs/explanation/architecture.md`
- Move: `docs/troubleshooting.md` → `docs/how-to/troubleshoot-common-problems.md`
- Modify: `README.md`, `CONTRIBUTING.md`, `SECURITY.md` (fix links to the five moved files)

**Interfaces:** None — this task only moves files and fixes links; no code.

- [ ] **Step 1: Move the five verbatim files with git mv**

```bash
mkdir -p docs/tutorials docs/how-to docs/reference docs/explanation examples
git mv docs/installation.md docs/how-to/install-sddx.md
git mv docs/hooks.md docs/reference/hooks.md
git mv docs/cli.md docs/reference/cli.md
git mv docs/architecture.md docs/explanation/architecture.md
git mv docs/troubleshooting.md docs/how-to/troubleshoot-common-problems.md
```

- [ ] **Step 2: Fix intra-file relative links broken by the move**

Each moved file cross-links its siblings by bare relative filename (e.g. `[hooks.md](hooks.md)`), which breaks once the files live in different subdirectories. Fix each:

In `docs/how-to/install-sddx.md`:
- `[cli.md](cli.md#sddx-config-show)` → `[../reference/cli.md](../reference/cli.md#sddx-config-show)`
- `[troubleshooting.md](troubleshooting.md#hooks-arent-firing)` → `[troubleshoot-common-problems.md](troubleshoot-common-problems.md#hooks-arent-firing)`

In `docs/reference/hooks.md`:
- `[receipts-and-audit.md](receipts-and-audit.md)` (two occurrences) → `[../reference/receipts-schema.md](../reference/receipts-schema.md)` — this target is created in Task 3; leave the link text pointing there now so Task 3 doesn't need to revisit this file.
- `[installation.md](installation.md)` → `[../how-to/install-sddx.md](../how-to/install-sddx.md)`

In `docs/reference/cli.md`:
- `[spec-reference.md](spec-reference.md)` → `[spec-reference.md](spec-reference.md)` (stays a sibling once Task 4 moves it into `reference/` too — no change needed)
- `[hooks.md](hooks.md)` → `[hooks.md](hooks.md)` (stays a sibling — no change needed)
- `[receipts-and-audit.md](receipts-and-audit.md)` (four occurrences, including anchored ones like `receipts-and-audit.md#findings-and-remediation`) → `[receipts-schema.md](receipts-schema.md)` (created in Task 3, same directory)
- `[installation.md](installation.md)` → `[../how-to/install-sddx.md](../how-to/install-sddx.md)`

In `docs/explanation/architecture.md`:
- `[usage.md](usage.md)` (two occurrences) → `[../tutorials/02-your-first-parallel-run.md](../tutorials/02-your-first-parallel-run.md)` (Task 8 creates this file; the worktree/cleanup material `usage.md` pointed to lives there)
- `[hooks.md](hooks.md)` → `[../reference/hooks.md](../reference/hooks.md)`
- `[receipts-and-audit.md](receipts-and-audit.md)` → `[../reference/receipts-schema.md](../reference/receipts-schema.md)`

In `docs/how-to/troubleshoot-common-problems.md`:
- `[hooks.md](hooks.md)` → `[../reference/hooks.md](../reference/hooks.md)`
- `[receipts-and-audit.md](receipts-and-audit.md#findings-and-remediation)` → `[../reference/receipts-schema.md](../reference/receipts-schema.md#findings-and-remediation)`
- `[installation.md](installation.md#skills-only-mode)` → `[install-sddx.md](install-sddx.md#skills-only-mode)`
- `[installation.md](installation.md#verifying-the-install)` → `[install-sddx.md](install-sddx.md#verifying-the-install)`
- `[cli.md](cli.md#sddx-task-phase)` → `[../reference/cli.md](../reference/cli.md#sddx-task-phase)`
- `[receipts-and-audit.md](receipts-and-audit.md)` → `[../reference/receipts-schema.md](../reference/receipts-schema.md)`

Use Edit (not sed) for each of these — every target file is small (under 130 lines) and each link is a unique string, so a plain string replace is safe and reviewable.

- [ ] **Step 3: Fix the five moved-file links in README.md, CONTRIBUTING.md, SECURITY.md**

In `README.md` line 43:
- Old: `see [docs/installation.md](docs/installation.md).`
- New: `see [docs/how-to/install-sddx.md](docs/how-to/install-sddx.md).`

In `README.md`'s Documentation table (lines 83-90), update only the `href`s that point at the five moved files — leave the table's row structure and every other row untouched (the full table gets replaced in Task 16):

```
| [Installation](docs/how-to/install-sddx.md)              | Every install path, verification, uninstall, privacy                  |
| [Usage](docs/usage.md)                                   | The task loop, `/sddx:run` and `/sddx:quick`, worktrees, the board    |
| [Spec reference](docs/spec-reference.md)                 | Every spec field, good/bad criteria, the four oracle types            |
| [Hooks & the TDD gate](docs/reference/hooks.md)           | The five hooks, gate classification, default globs, the escape hatch  |
| [CLI reference](docs/reference/cli.md)                    | Every `sddx` command, flag, and exit code                             |
| [Receipts & audit](docs/receipts-and-audit.md)           | Receipt schema, the hash chain, audit findings and remediation        |
| [Architecture](docs/explanation/architecture.md)          | Codebase map, build pipeline, state model, design principles          |
| [Troubleshooting](docs/how-to/troubleshoot-common-problems.md) | Gate blocks, stuck tasks, orphan worktrees, audit failures       |
```

(`docs/usage.md`, `docs/spec-reference.md`, `docs/receipts-and-audit.md` rows are fixed in Tasks 3, 4, and 8 respectively — leave them as-is here.)

In `CONTRIBUTING.md` line 5:
- Old: `[docs/architecture.md](docs/architecture.md).`
- New: `[docs/explanation/architecture.md](docs/explanation/architecture.md).`

`SECURITY.md` line 18 links `docs/receipts-and-audit.md`, which Task 3 relocates — leave it untouched here; Task 3 fixes it directly since that task is the one moving the target.

- [ ] **Step 4: Verify no broken intra-repo links remain among the moved files**

Run: `grep -rn "](installation\.md\|](hooks\.md\|](cli\.md\|](architecture\.md\|](troubleshooting\.md" docs/ README.md CONTRIBUTING.md SECURITY.md`
Expected: no output (empty) — every bare-filename link to the five old names has been rewritten to its new path.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (this task touches no source, so this simply confirms nothing broke).

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md CONTRIBUTING.md
git commit -m "docs: move installation/hooks/cli/architecture/troubleshooting into a Diataxis layout"
```

---

### Task 3: Split receipts-and-audit.md into reference + how-to

**Files:**
- Create: `docs/reference/receipts-schema.md`
- Create: `docs/how-to/verify-and-audit-receipts.md`
- Delete: `docs/receipts-and-audit.md`
- Modify: `SECURITY.md`, `README.md` (fix links to the deleted file)

**Interfaces:** None — content split, no code. `docs/how-to/verify-and-audit-receipts.md` will later gain a link to `examples/07-receipts-and-audit/` in Task 13.

- [ ] **Step 1: Write `docs/reference/receipts-schema.md`** (the schema/lookup half — field table, hash chain, audit's checks, findings table)

```markdown
# Receipt schema

One JSON file per task at `.sddx/receipts/<task-id>.json`, written exactly
once by the verifier — and only on a passing oracle. A failed verification
writes nothing; there are no failure receipts, so `verdict` is always
`"pass"`.

| Field            | Type              | Meaning                                                                  |
| ---------------- | ----------------- | ------------------------------------------------------------------------ |
| `version`        | `1 \| 2 \| 3`     | Receipt schema; v2 added `allow`, v3 added `runs`/`env`                  |
| `task_id`        | string            | The task this receipt settles                                            |
| `seq`            | number            | Position in the chain; strictly greater than the parent's                |
| `prev`           | string            | sha256 of the parent receipt *file*, or `"genesis"` for the first        |
| `harness`        | string            | Harness that ran the loop (e.g. `claude-code`)                           |
| `model`          | string \| null    | Model provenance, when known                                             |
| `plugin_version` | string            | sddx version that wrote the receipt                                      |
| `oracle`         | `{run, expect}`   | The exact command executed and the expectation                           |
| `exit_code`      | number            | Observed oracle exit code                                                |
| `duration_ms`    | number            | Oracle wall-clock duration                                               |
| `stdout_sha256`  | string            | Hash of the oracle's stdout — output is attested without being stored    |
| `stderr_sha256`  | string            | Hash of the oracle's stderr                                              |
| `base_sha`       | string            | Commit the task forked from                                              |
| `tree_sha`       | string            | Git tree the oracle ran against                                          |
| `verdict`        | `"pass"`          | Always `pass` — failed verifications write no receipt                    |
| `verified_at`    | string            | ISO timestamp                                                            |
| `allow`          | string[] (v2)     | The task's audited TDD-gate exemptions; empty when none                  |

The `allow` field closes the loop on the gate's only escape hatch
([hooks.md](hooks.md)): every exemption a task used is part of its permanent
record.

## Receipt v3 (sddx ≥ 0.2)

v3 replaces the single run record (`exit_code`, `duration_ms`,
`stdout_sha256`, `stderr_sha256`) with `runs: []` — one entry per oracle
execution, each carrying those same four fields; a pass requires every entry
to exit 0. It adds `env` (`os`, `arch`, `runtime`, `runtime_version`,
`dirty_tree` — whether the oracle ran against uncommitted changes) and
optional `signature`/`signer` (see
[verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md#receipt-signing)).
`sddx audit` accepts v1–v3; existing chains stay valid.

## The hash chain

Each receipt's `prev` is the sha256 of its parent receipt **file** (the exact
bytes on disk), and the first receipt links to `"genesis"` with `seq` 1.
Editing any receipt changes its file hash, which orphans every descendant —
tampering is loud, not silent.

Strictly, receipts form a hash **tree** rooted at genesis: parallel worktrees
legitimately write sibling receipts sharing one parent, so validation requires
every `prev` to match the file hash of a receipt with strictly smaller `seq`.
The linear chain is just the sequential special case.

## What audit checks

`sddx audit` re-walks the whole receipts directory:

1. **Schema** — every receipt has every required field, valid
   (`<field>: missing or invalid` per violation).
2. **Chain integrity** — every `prev` resolves to an existing receipt's file
   hash; genesis receipts have `seq` 1; children outnumber their parents'
   `seq`.
3. **Commit binding** — each receipt file was introduced by a commit, and its
   working-tree bytes match the committed bytes. A receipt that exists only in
   the working tree is unverifiable and flagged.
4. **Signatures** (`--signatures`) — the commit that introduced each receipt
   carries a valid signature, when you have commit signing configured.

Exit 1 on any finding, 0 on a clean chain — safe to wire into CI (see
[verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md#wire-audit-into-ci)).

## Findings and remediation

| Finding                                                             | Meaning                                                       | What to do                                                                     |
| --------------------------------------------------------------------| --------------------------------------------------------------| --------------------------------------------------------------------------------|
| `chain: <file>: prev hash matches no receipt — chain broken (tampered or deleted)` | A parent receipt was edited or removed          | Restore the original bytes from git history (`git checkout <sha> -- <file>`)   |
| `chain: <file>: genesis-linked receipt must have seq 1, got <n>`    | The chain root was rewritten                                  | Restore from history; a legitimate root always has seq 1                       |
| `chain: <file>: seq <n> must exceed parent seq <m>`                 | Sequence numbers were manipulated                             | Restore from history                                                           |
| `chain: <file>: <field>: missing or invalid`                        | Receipt edited into an invalid shape                          | Restore from history                                                           |
| `<file>: committed receipt missing from working tree — receipt deleted` | A committed receipt was deleted locally                   | `git checkout -- .sddx/receipts/` to restore it                                |
| `<file>: working tree differs from committed state — receipt bytes tampered` | Local edits to a committed receipt               | Restore the committed bytes; receipts are immutable                            |
| `<file>: not bound to any commit — an uncommitted receipt is unverifiable` | Receipt never committed (interrupted verify?)      | Commit it if legitimate, or delete and re-run `sddx verify`                    |
| `<file>: commit binding failed: <err>`                              | Git couldn't answer which commit introduced the file          | Check repository health (shallow clone? rewritten history?)                    |
| `<file>: binding commit <sha> has no valid signature`               | `--signatures` only: introducing commit unsigned/invalid      | Expected if signing isn't configured; otherwise investigate the commit         |

If a finding survives restoration attempts, treat the receipt as untrusted and
re-verify the task: the code may be fine, but its proof is gone.
```

- [ ] **Step 2: Write `docs/how-to/verify-and-audit-receipts.md`** (the procedural half — inspecting, running audit, CI wiring, signing)

```markdown
# Verify and audit receipts

How to inspect a task's receipt by hand, run `sddx audit` locally and in CI,
and turn on commit/receipt signing. Field-by-field schema lives in
[receipts-schema.md](../reference/receipts-schema.md); a full runnable
walkthrough — including deliberately tampering with a receipt and watching
audit catch it — is in
[examples/07-receipts-and-audit](../../examples/07-receipts-and-audit/).

## Inspect a receipt

Every settled task has exactly one receipt file:

```sh
cat .sddx/receipts/<task-id>.json
```

Pull a single field without a JSON tool (sddx ships no runtime dependencies,
so examples avoid assuming `jq` is installed):

```sh
grep -o '"verdict":"[^"]*"' .sddx/receipts/<task-id>.json
```

## Run audit locally

```sh
sddx audit
```

Prints `audit: <n> receipt(s) verified, chain intact` and exits 0 on a clean
chain, or one `chain: …`/`<file>: …` line per finding on stderr and exits 1 —
see [receipts-schema.md](../reference/receipts-schema.md#findings-and-remediation)
for what each finding means and how to fix it. Add `--signatures` to also
verify the commit that introduced each receipt is signed.

## Wire audit into CI

`sddx audit --ci` exits non-zero **only on tamper evidence**: a broken
receipt hash chain; edited, deleted, uncommitted, or schema-invalid receipts;
or a task marked `DONE` without a receipt. A repo or PR with no sddx activity
passes clean — safe to add to any repository; sddx stays opt-in per task.

Zero-install workflow (the committed `dist/` bundle needs no npm install):

```yaml
name: sddx-audit
on: pull_request
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # audit binds receipts to their introducing commits
      - uses: actions/checkout@v4
        with:
          repository: glapsfun/sddx
          ref: v0.2.0
          path: .sddx-tool
      - run: node .sddx-tool/dist/cli.mjs audit --ci
```

## Enable commit signing

When you have git commit signing (SSH or GPG) configured, sddx's atomic task
commits are signed like any other commit, and `sddx audit --signatures`
verifies them. Signing adds **identity** on top; chain **integrity** is
independent of it — an unsigned repository still gets full tamper-evidence
from the hash tree.

## Enable receipt signing

When the repo has SSH commit signing configured (`gpg.format ssh` +
`user.signingkey` as a key path), `sddx verify` also signs each receipt:
`signature` is an SSH signature (namespace `sddx-receipt`) over the sha256 of
the receipt's unsigned bytes; `signer` is the git `user.email`. `sddx audit`
verifies embedded signatures against `gpg.ssh.allowedSignersFile`: invalid →
audit fails; unsigned or unverifiable → informational only (`--signatures`
prints the notes). Identity sits on top; chain integrity never depends on it.
```

- [ ] **Step 3: Delete the old combined doc and fix its remaining referrers**

```bash
git rm docs/receipts-and-audit.md
```

In `SECURITY.md` line 18:
- Old: `[docs/receipts-and-audit.md](docs/receipts-and-audit.md).`
- New: `[docs/reference/receipts-schema.md](docs/reference/receipts-schema.md).`

In `README.md`'s Documentation table, the `Receipts & audit` row:
- Old: `| [Receipts & audit](docs/receipts-and-audit.md)           | Receipt schema, the hash chain, audit findings and remediation        |`
- New: `| [Receipts & audit](docs/reference/receipts-schema.md)    | Receipt schema, the hash chain, audit findings and remediation        |`

- [ ] **Step 4: Confirm no dangling links to the deleted file**

Run: `grep -rn "receipts-and-audit" . --include="*.md" 2>/dev/null | grep -v node_modules`
Expected: no output.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/ SECURITY.md README.md
git commit -m "docs: split receipts-and-audit.md into a reference schema page and a how-to guide"
```

---

### Task 4: Move and extend spec-reference.md

`src/lib/spec.ts` validates `scope`, `on_dependency_failure`, and `retry` (added by the multi-parent DAG commit), but `docs/spec-reference.md` documents neither — this task moves the file into `reference/` and closes that gap.

**Files:**
- Move: `docs/spec-reference.md` → `docs/reference/spec-reference.md`
- Modify: `README.md` (fix the row link)

**Interfaces:** None.

- [ ] **Step 1: Move the file**

```bash
git mv docs/spec-reference.md docs/reference/spec-reference.md
```

- [ ] **Step 2: Add the three undocumented fields**

Using Edit on `docs/reference/spec-reference.md`, insert three new sections after `## out_of_scope` (the file's last section), and add `scope`, `on_dependency_failure`, `retry` to the complete example at the top of the file.

Replace the complete example at the top:

```yaml
task: health endpoint returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
```

with:

```yaml
task: health endpoint returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
scope:
  - "src/health/**"
```

(`on_dependency_failure` and `retry` are omitted from the top example since both default sensibly when absent — each gets its own worked example below.)

Append after `## out_of_scope`:

````markdown
## scope

Optional list of write globs — the task's lane. When two tasks in the same
`graph.yaml` run aren't ordered by `depends_on`, their `scope` lists must be
disjoint; `graph create`/`goal create` refuse a schedule that violates this
("overlap ⟹ ordered" — see
[model-dag-dependencies.md](../how-to/model-dag-dependencies.md)). When
present, must be a non-empty list of non-empty globs — a bare string or an
empty list is rejected (`scope: when present, must be a non-empty list of
non-empty globs`), not silently coerced into one.

```yaml
scope:
  - "src/health/**"
```

Omitting `scope` entirely means the task carries no scope-conflict
information — safe for a single unscoped task, but it can never safely run
concurrently (unordered) with another task in the same graph.

## on_dependency_failure

Optional. One of `skip` (default) or `block` — what this task does if a
named parent (`depends_on` in `graph.yaml`) never reaches `DONE` (goes
`ABANDONED` instead). Carries no cross-task reference, unlike `depends_on`
itself, which stays out of the spec entirely and is authored in
`graph.yaml` (`on_dependency_failure: must be one of skip | block`
otherwise).

```yaml
on_dependency_failure: block # default is skip
```

- `skip` — this task (and, transitively, anything that depends on it) is
  reported as **Skipped** on the board once its parent is abandoned; the rest
  of the goal keeps running.
- `block` — this task stays **Blocked** and escalates instead.

See [configure-retry-and-skip.md](../how-to/configure-retry-and-skip.md) for
a full walkthrough.

## retry

Optional mapping — bounds automatic re-attempts before a task that would
otherwise go `ABANDONED` is retried instead.

```yaml
retry:
  max_attempts: 2 # integer >= 1; default 1 (today's single-attempt behavior)
  workspace: fresh # fresh (default) | reuse
```

- `max_attempts` — total attempts including the first; when a task is
  abandoned with attempts remaining it resets to `PLAN` instead
  (`attempt_count` increments) rather than terminating.
- `workspace` — `fresh` discards and re-forks the worktree/branch from the
  same base SHA before the next attempt; `reuse` leaves the existing
  workspace as-is.

Retry never reopens an already-`DONE` task — a receipt is immutable once
written. See
[configure-retry-and-skip.md](../how-to/configure-retry-and-skip.md).
````

- [ ] **Step 3: Fix the README row link**

In `README.md`'s Documentation table:
- Old: `| [Spec reference](docs/spec-reference.md)                 | Every spec field, good/bad criteria, the four oracle types            |`
- New: `| [Spec reference](docs/reference/spec-reference.md)       | Every spec field, good/bad criteria, the four oracle types            |`

- [ ] **Step 4: Cross-check against `src/lib/spec.ts`**

Run: `grep -n "errors.push" src/lib/spec.ts`
Expected: every error string in the output has a corresponding sentence or
inline code span in `docs/reference/spec-reference.md` naming that exact
rule. If any is missing, add it — this is the accuracy check for this task.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/reference/spec-reference.md README.md
git commit -m "docs: move spec-reference.md into reference/ and document scope/retry/on_dependency_failure"
```

---

### Task 5: New reference/config.md

`userConfig` keys today are documented only as doc-comments in
`.claude-plugin/plugin.json` and a table in the old installation page. This
task gives them a standalone reference page, sourced from `src/lib/config.ts`
(the actual precedence resolver) so the precedence column is verifiably
accurate rather than restated from memory.

**Files:**
- Create: `docs/reference/config.md`
- Modify: `README.md` (add a new Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Write `docs/reference/config.md`**

```markdown
# Config reference

Every `userConfig` key sddx resolves, in precedence order (highest wins):
**environment variable** (where one exists) → **`.sddx/config.json`** →
**built-in default**. Inside Claude Code, enabling the plugin prompts for
these and materializes them into `.sddx/config.json` for you — there are no
hand-edited files in that path. Outside Claude Code (standalone CLI), write
`.sddx/config.json` yourself; see
[tune-config.md](../how-to/tune-config.md) for a worked example and
[cli.md](cli.md#sddx-config-show) for the `sddx config show`/`sddx config
validate` commands that read and check it.

| Key                       | Env var                 | Default            | Meaning                                                                                                  |
| -------------------------- | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------|
| `workspace_mode`           | —                        | `auto`              | Task workspace strategy: `auto` \| `worktree` \| `branch` \| `none`                                      |
| `test_globs`                | `SDDX_TEST_GLOBS`        | *(empty)*            | Space-separated extra globs classified as test files by the TDD gate                                     |
| `exempt_globs`              | `SDDX_EXEMPT_GLOBS`      | *(empty)*            | Space-separated extra globs exempt from the RED-phase write block                                        |
| `max_iterations_default`   | —                        | `5`                  | Default stop rule: max loop iterations per task                                                           |
| `board_enabled`             | `SDDX_BOARD_ENABLED`     | `true`               | Regenerate `.sddx/BOARD.md` automatically                                                                 |
| `oracle_runs_default`       | `SDDX_ORACLE_RUNS`       | `1`                  | How many times `sddx verify` executes the oracle; every run must pass (flakiness detection)               |
| `red_bash_allow`            | `SDDX_RED_BASH_ALLOW`    | *(empty)*            | Space-separated extra commands the RED-phase Bash gate allows (extends, never replaces, the built-in list)|
| `stuck_threshold`           | `SDDX_STUCK_THRESHOLD`   | `3`                  | Consecutive identical test failures before a task is flagged stuck                                        |
| `pr_host`                   | —                        | *(auto-detected)*     | PR-host CLI for `sddx pr create`: `gh` \| `glab`. Unset detects from the `origin` remote                  |
| `agent_model`               | —                        | *(empty)*             | Comma-separated `role=model` pairs (`orchestrator`, `planner`, `tddExecutor`, `verifier`) — advisory only |
| `prefer_solo`                | —                        | `false`               | Advisory hint `/sddx:run` reads to steer a single trivial task toward `--solo`/`/sddx:quick`             |
| `verbose`                    | —                        | `false`               | When true, `sddx config show` also prints which source resolved each key                                  |

A key with no env var column entry is resolved from `.sddx/config.json` or
the built-in default only — setting an environment variable of a similar
name has no effect on it.

## Validation

`sddx config validate` checks `.sddx/config.json` against the schema above
and reports, as **warnings** (exit 0, never a hard failure for a
structurally-valid file): unrecognized top-level keys, and values that fail
their key's domain rule — not just a `typeof` mismatch. `stuck_threshold`,
`oracle_runs_default`, and `max_iterations_default` must be positive
integers; `workspace_mode` must be one of `auto|worktree|branch|none`;
`pr_host` one of `gh|glab`; malformed `agent_model` segments (not
`role=model`, or an unrecognized role) are reported individually. A missing
`.sddx/config.json` is not an error — built-in defaults apply. The one case
that **does** fail loudly (exit 1) is unparseable JSON, or JSON that isn't an
object — that is a broken file, not a schema mismatch.

## `agent_model` parsing

`agent_model` is a single string of comma-separated `role=model` pairs, e.g.
`orchestrator=opus,tddExecutor=sonnet`. Recognized roles: `orchestrator`,
`planner`, `tddExecutor`, `verifier`. A malformed segment (no `=`, empty
model, or an unrecognized role) is dropped individually with a warning
rather than invalidating the whole value. This key is **advisory only**:
`/sddx:run` and `/sddx:quick` read it via `sddx config show --output json`
when dispatching a subagent, but no hook enforces it.
```

- [ ] **Step 2: Add the README row**

In `README.md`'s Documentation table, insert a new row directly after the
`CLI reference` row:

```
| [Config reference](docs/reference/config.md)              | Every `userConfig` key, its env var, default, and precedence          |
```

- [ ] **Step 3: Cross-check against `src/lib/config.ts`**

Run: `grep -n "envVar:" src/lib/config.ts`
Expected: every env var name in the output (`SDDX_STUCK_THRESHOLD`,
`SDDX_ORACLE_RUNS`, `SDDX_BOARD_ENABLED`, `SDDX_TEST_GLOBS`,
`SDDX_EXEMPT_GLOBS`, `SDDX_RED_BASH_ALLOW`) appears in the table above next
to the matching key. If `config.ts` changes this list in the future, this
grep is the accuracy check to re-run.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/config.md README.md
git commit -m "docs: add a standalone userConfig reference page"
```

---

### Task 6: The explanation quadrant (why-sddx, design-principles, how-it-compares)

**Files:**
- Create: `docs/explanation/why-sddx.md`
- Create: `docs/explanation/design-principles.md`
- Create: `docs/explanation/how-it-compares.md`
- Modify: `docs/explanation/architecture.md` (dedupe: its "Design principles" section moves to `design-principles.md`)
- Modify: `README.md` (rewrite the "Problem" table's target into a link, add three new rows)

**Interfaces:** None.

- [ ] **Step 1: Write `docs/explanation/why-sddx.md`**

```markdown
# Why sddx

**One sentence:** a fast, dense alternative to Superpowers — process over
intelligence, proof over promises.

sddx is a lightweight, loop-based Spec-Driven Development (SDD) framework,
shipped as a first-class Claude Code plugin. It turns vague development goals
into dense, machine-verifiable specs, executes them through strict
hook-enforced TDD across parallel git worktrees, and leaves behind a
tamper-evident audit trail of receipts inside the repository.

## The problem

Agentic dev frameworks suffer from five recurring failure modes:

- **Token bloat.** Large always-on skill libraries tax every session before
  any work starts.
- **Prompt-level discipline.** "Write the test first" is a request, not a
  rule — the model can and does skip it.
- **Unverifiable completion.** "Done" is a model claim, not an observable
  fact.
- **Transient state.** Progress lives in the chat session and dies with it.
- **Sequential compounding.** Consecutive tasks on one branch contaminate
  each other.

## The answer

| Problem                 | sddx mechanism                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------|
| Token bloat              | Minimal skill surface; lazy-loaded references; measured token budget                        |
| Prompt-level discipline  | **Hooks hard-block** implementation writes before a failing test exists                     |
| Unverifiable completion  | Every goal requires an **oracle** — an observable success signal; the verifier executes it  |
| Transient state          | Per-task JSON state + receipts committed **in the repo**; survives restarts and compaction  |
| Compounding tasks        | **Worktree-per-task** isolation, forked from `origin/HEAD`, parallel by default              |

The mechanisms themselves are covered task-by-task starting from
[docs/tutorials/01-getting-started.md](../tutorials/01-getting-started.md);
the reasoning behind each one is in
[design-principles.md](design-principles.md).

## Non-goals (v1)

- A live web UI board — sddx generates `BOARD.md` only.
- Support or testing for harnesses other than Claude Code (state formats stay
  harness-neutral; every receipt records `harness:`).
- Large-scale project management (epics, sprints). sddx targets small-to-medium
  tasks and batches of them.

## Success metrics

- Fresh install → first verified task in **< 10 minutes**.
- Always-on token cost **< ~500 tokens** per session (enforced in CI by
  `scripts/token-budget.ts`).
- The TDD gate integration suite: an implementation-first attempt is
  **always** blocked; a test-first path **always** passes.
- Two or more parallel tasks complete with **zero** merge conflicts in
  `.sddx/` and a valid receipt chain.
- `sddx audit` detects any tampered or deleted receipt.
```

- [ ] **Step 2: Write `docs/explanation/design-principles.md`**

```markdown
# Design principles

The tie-breakers for any design argument, in order of how often they settle
one. When two things sddx could do conflict, the earlier principle wins.

1. **Process over intelligence.** Trust deterministic gates — hooks, schemas,
   exit codes — over model judgment. A rule enforced by a hook can't be
   rationalized around; a rule stated in a prompt can.
2. **No oracle, no goal.** A spec without an observable success signal is
   rejected at plan time, mechanically — see
   [spec-reference.md](../reference/spec-reference.md#oracle).
3. **State is files in git.** If it isn't committed, it didn't happen. Task
   state, specs, and receipts all live under version-controlled `.sddx/`, not
   in a chat session that dies with the context window.
4. **Hard rules, audited exceptions.** The only escape from the TDD gate is
   per-file, written down (`sddx task allow`), and surfaced in the receipt
   and on the board — see
   [../reference/hooks.md](../reference/hooks.md#the-allow-escape-hatch).
5. **Pay for what you use.** Subagents and worktrees only when the task
   warrants them; `--solo` runs a trivial task in the main session under the
   same hook gates, with no orchestration overhead.
6. **Zero trust in "done".** Completion is a verifier executing the oracle
   and writing a chained receipt — never a model claim. See
   [verify-and-audit-receipts.md](../how-to/verify-and-audit-receipts.md).

## Product goals

- **Density.** A goal becomes a one-page spec with binary success criteria,
  an oracle, and stop rules — no ceremonial documents.
- **Deterministic TDD.** Red → Green → Refactor enforced by hooks, not by
  prompting. Hard-block, no soft mode.
- **Parallel by default.** `/sddx:run` decomposes work and dispatches tasks
  across isolated worktrees concurrently.
- **Provable completion.** Every finished task produces a
  machine-validated, hash-chained receipt bound to a commit SHA.
- **Repo-persistent.** All state lives in `.sddx/` under version control, in
  harness-neutral file formats.
- **Zero-footprint install.** No runtime dependencies; bundled single-file
  scripts; no network calls anywhere in the always-on core loop (install,
  hooks, session start). `sddx pr create` is the one stated exception — an
  explicitly user-invoked command that shells out to `git push`/`gh`/`glab`,
  opt-in and never part of the hot path.

## Why phases are evidence, not claims

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

- **PLAN** — the task exists with a spec and an oracle; writes to
  implementation paths are blocked.
- **RED** — a failing test has been *observed*, not asserted: the recorder
  saw the test runner exit non-zero (or, from the raw CLI,
  `task phase <id> RED --test-exit <n>` is refused unless `<n>` is actually
  non-zero).
- **GREEN** — the same observation, this time a zero exit. The gate opens.
- **REFACTOR** — optional cleanup; the tests must stay green.
- **VERIFY** — `sddx verify` executes the spec's oracle for real, writes a
  hash-chained receipt, and commits code + spec + receipt atomically.
- **DONE** — set only by the verifier, never claimed by hand.

This is principle 1 and principle 6 made concrete: nothing here is the model
saying "I'm done" — every transition is a hook or a CLI command reacting to
a real exit code.
```

- [ ] **Step 3: Write `docs/explanation/how-it-compares.md`**

```markdown
# How sddx compares

sddx borrows deliberately from several existing agentic-dev frameworks. This
page names what came from where, so the design choices read as informed
rather than arbitrary.

| Framework       | What sddx takes                                                                 |
| ---------------- | ---------------------------------------------------------------------------------|
| **Superpowers**  | The skills-library ambition and subagent-driven development model — sddx keeps the ambition, cuts the weight (measured token budget, hard-block hooks instead of prompted discipline). |
| **Blueprint**    | Process-over-intelligence as a design stance, and the loop-primitive shape (task-to-PR, multitask orchestration). |
| **GoalBuddy**    | The oracle principle itself — no goal is valid without an observable success signal — plus local boards and cross-harness state formats. |
| **gsd-core**     | The planner/executor/verifier subagent hierarchy for small, ad-hoc tasks with quality guarantees. |
| **BMAD-METHOD**  | The developer-workflow integration mindset — meeting an existing team's git/PR habits rather than replacing them. |

None of these are dependencies or forks — sddx is a from-scratch
implementation that reuses their *ideas*, adapted to a hook-enforced,
receipt-audited loop. See [design-principles.md](design-principles.md) for
how those ideas resolve into sddx's own tie-breakers, and
[architecture.md](architecture.md) for where they land in the codebase.
```

- [ ] **Step 4: Dedupe `docs/explanation/architecture.md`'s "Design principles" section**

Using Edit on `docs/explanation/architecture.md`, replace:

```
## Design principles

The tie-breakers for any design argument, in order of how often they settle
one:

1. **Process over intelligence.** Trust deterministic gates — hooks, schemas,
   exit codes — over model judgment.
2. **No oracle, no goal.** A spec without an observable success signal is
   rejected at plan time, mechanically.
3. **State is files in git.** If it isn't committed, it didn't happen.
4. **Hard rules, audited exceptions.** The only gate escape is per-file,
   written down, and surfaced in the receipt and on the board.
5. **Pay for what you use.** Subagents and worktrees only when the task
   warrants them; `--solo` exists for a reason.
6. **Zero trust in "done".** Completion is a verifier executing the oracle and
   writing a chained receipt — never a model claim.
```

with:

```
## Design principles

The tie-breakers for any design argument are covered in
[design-principles.md](design-principles.md) — this page stays focused on
where they land in the codebase.
```

Also update the file's opening line (currently `Reader-facing behavior is
documented in [usage.md](usage.md), [hooks.md](hooks.md), and
[receipts-and-audit.md](receipts-and-audit.md).` — already partially
redirected by Task 2) to read:

```
Reader-facing behavior is documented in the tutorials, how-to guides, and
[../reference/hooks.md](../reference/hooks.md); the reasoning behind each
design choice is in [design-principles.md](design-principles.md) and
[why-sddx.md](why-sddx.md).
```

- [ ] **Step 5: Update README.md's Problem/answer table and Documentation list**

Replace the standalone problem/answer table currently sitting between the
badges and `## Install` in `README.md` (the one duplicated verbatim in this
task's `why-sddx.md`) with a two-line teaser plus a link, so the table has
exactly one canonical home:

Old (the table block right after the pitch paragraph):
```
| Problem with agentic dev frameworks | sddx mechanism                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Token bloat             | Minimal skill surface; lazy-loaded references; measured token budget                       |
| Prompt-level discipline | **Hooks hard-block** implementation writes before a failing test exists                    |
| Unverifiable completion | Every goal requires an **oracle** — an observable success signal; the verifier executes it |
| Transient state         | Per-task JSON state + receipts committed **in the repo**; survives restarts and compaction |
| Compounding tasks       | **Worktree-per-task** isolation, forked from `origin/HEAD`, parallel by default            |
```

New:
```
Hooks hard-block implementation writes before a failing test exists, every
goal requires an executable oracle, and every finished task leaves a
hash-chained receipt in the repo. See
[why sddx exists](docs/explanation/why-sddx.md) for the full problem/mechanism
breakdown.
```

Add three new Documentation-table rows (placed after the `Architecture` row,
before `Troubleshooting`):

```
| [Design principles](docs/explanation/design-principles.md) | The tie-breakers behind every design choice, plus the product goals   |
| [How it compares](docs/explanation/how-it-compares.md)    | What sddx takes from Superpowers, Blueprint, GoalBuddy, gsd-core, BMAD |
```

(`why-sddx.md` is linked inline above rather than added as its own row, since
Task 16 replaces this whole table with the grouped Diataxis layout anyway —
avoid adding a row here that Task 16 immediately restructures.)

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/explanation/ README.md
git commit -m "docs: add the explanation quadrant (why-sddx, design-principles, how-it-compares)"
```

---

### Task 7: Tutorial 1 + Example 01 — single task, start to finish

The first real exercise of the Task 1 harness. This example corrects a real
gap in the current docs: neither `usage.md` nor the README quickstart
mentions `sddx red-check`, which `sddx verify` has required since sddx 0.2
(`verifyTask` throws `"...has no failing-oracle evidence..."` without it) —
confirmed by reading `src/lib/verify.ts` and `tests/deps.e2e.test.ts`'s
`driveToDone` helper. This task's example is the corrected, currently-accurate
sequence.

**Files:**
- Create: `examples/01-single-task/setup.sh`
- Create: `examples/01-single-task/README.md`
- Create: `docs/tutorials/01-getting-started.md`
- Modify: `README.md` (fix the `usage.md` teaser link at line 43 to point here instead — the CLI walkthrough this tutorial supersedes)

**Interfaces:** None — this is the first consumer of Task 1's `runExample`/`discoverExamples`, exercised manually in Step 4 below (Task 16 wires permanent CI coverage).

- [ ] **Step 1: Write the setup script**

Create `examples/01-single-task/setup.sh`:

```sh
#!/bin/sh
# Scratch git repo + a local ./sddx shim so this example runs against the
# current checkout without a global install. $1 (optional) is the target
# directory; defaults to a gitignored .sandbox/ next to this script for a
# convenient local run. The harness always passes an external tmpdir.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-$SCRIPT_DIR/.sandbox}"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cat > "$TARGET/sddx" <<SHIM
#!/bin/sh
exec "$REPO_ROOT/bin/sddx-run" "$REPO_ROOT/dist/cli.mjs" "\$@"
SHIM
chmod +x "$TARGET/sddx"
cd "$TARGET"
git init -q -b main
git config user.email "example@sddx.invalid"
git config user.name "sddx example"
git config commit.gpgsign false
git commit -q --allow-empty -m init
echo "$TARGET"
```

- [ ] **Step 2: Write the example README**

Create `examples/01-single-task/README.md`:

````markdown
# Example: a single task, start to finish

The base loop for one task with no worktree — `sddx task create --workspace
none`, the same primitive `--solo`/`/sddx:quick` drive inside Claude Code.
Every other example builds on this one.

## Setup

From the repo root:

```sh skip
bash examples/01-single-task/setup.sh
```

This prints a scratch directory with a local `./sddx` shim. `cd` there before
running anything below. Installed sddx globally instead (see
[install-sddx.md](../../docs/how-to/install-sddx.md))? Use plain `sddx`
throughout.

## Write the spec

```sh
cat > spec.yaml <<'EOF'
task: health check returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
EOF
```

## Register the task

```sh
OUT=$(./sddx task create --spec spec.yaml --workspace none)
echo "$OUT"
ID=$(echo "$OUT" | awk '{print $2}')
```

`task create` prints `created <id> phase=PLAN ...`; `$ID` carries the id
(`YYYYMMDD-<slug>`) into every command below.

## Write the failing test first

```sh
mkdir -p tests
cat > tests/health.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { health } from "../health";

test("health check returns ok", () => {
  expect(health()).toEqual({ status: "ok" });
});
EOF
```

`../health` doesn't exist yet — the run below fails, which is the point.

```sh expect=1
bun test tests/health.test.ts
```

## Move to RED, with real proof

```sh
./sddx task phase "$ID" RED --test-exit 1
```

`--test-exit` is checked, not trusted — a `0` here is refused. Now record
that the spec's own oracle (the same command) fails too, while the
implementation still doesn't exist — `sddx verify` later refuses without
this:

```sh
./sddx red-check "$ID"
```

## Implement, watch it go green

```sh
cat > health.ts <<'EOF'
export function health(): { status: string } {
  return { status: "ok" };
}
EOF
```

```sh
bun test tests/health.test.ts
```

```sh
./sddx task phase "$ID" GREEN --test-exit 0
```

## Verify

```sh
./sddx task phase "$ID" VERIFY
```

```sh
./sddx verify "$ID"
```

On success this writes `.sddx/receipts/$ID.json` and makes one atomic commit
containing `health.ts`, `tests/health.test.ts`, `spec.yaml`, and the receipt.

## Check the board and the chain

```sh
./sddx board
```

```sh
./sddx audit
```

`audit` re-walks the receipt chain and exits 0 on `chain intact`. See
[examples/07-receipts-and-audit](../07-receipts-and-audit/) for what happens
when it isn't.
````

- [ ] **Step 3: Write the tutorial**

Create `docs/tutorials/01-getting-started.md`:

```markdown
# Getting started: your first verified task

This walks the same loop `/sddx:quick` (or `--solo`) drives inside Claude
Code, by hand from the CLI, so you can see every phase transition as it
happens. The exact commands are also a copy-paste-able scaffold at
[examples/01-single-task](../../examples/01-single-task/).

## The loop

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

Every arrow is a hook or a CLI command reacting to a real exit code, never a
model claim — see
[design-principles.md](../explanation/design-principles.md#why-phases-are-evidence-not-claims)
for why that's the whole point.

## 1. Register a task from a spec

A spec is one YAML file with a one-sentence goal, binary success criteria,
and a mandatory **oracle** — the command that proves the task is done:

```yaml
task: health check returns ok
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
```

`sddx task create --spec spec.yaml --workspace none` registers it and prints
`created <id> phase=PLAN ...` — `--workspace none` runs in place, no branch,
no worktree (see
[../tutorials/02-your-first-parallel-run.md](02-your-first-parallel-run.md)
for the worktree case). A spec without an oracle is rejected right here —
"no oracle, no goal" — see
[spec-reference.md](../reference/spec-reference.md#oracle).

## 2. Write the failing test first

The task starts in `PLAN`. Write a test against code that doesn't exist yet,
run it, and watch it fail — that failure **is** the RED-phase evidence:

```sh
bun test tests/health.test.ts   # fails: module not found
```

`sddx task phase <id> RED --test-exit 1` records that observed exit code;
passing `--test-exit 0` here is refused outright — the transition demands
real evidence, not a claim.

## 3. Prove the oracle itself discriminates

Before implementing, run `sddx red-check <id>` — it executes the spec's own
oracle command right now, while the implementation is still missing, and
records the failure as `evidence.oracle_red`. `sddx verify` later refuses any
task missing this: an oracle that never failed proves nothing.

## 4. Implement, go green

Write the implementation, re-run the test, and once it passes,
`sddx task phase <id> GREEN --test-exit 0` records that too. The optional
`REFACTOR` phase is free cleanup time — tests just have to stay green.

## 5. Verify

`sddx task phase <id> VERIFY` then `sddx verify <id>` executes the oracle for
real, writes a hash-chained receipt to `.sddx/receipts/<id>.json`, and makes
one atomic commit of the code, the spec, and the receipt. `sddx board` and
`sddx audit` confirm the result — the full receipt schema and what audit
checks are in
[receipts-schema.md](../reference/receipts-schema.md).

## Inside Claude Code

The same loop, without the by-hand phase commands: `/sddx:quick` drives one
task through this exact sequence, ending in the deterministic **Next
Actions** menu instead of free-form "what's next" prose. `--solo` is the same
thing said explicitly for a trivial task — no subagents, no worktree, same
hook gates. Next:
[your first parallel run](02-your-first-parallel-run.md).
```

- [ ] **Step 4: Manually exercise the harness against this example**

Run:

```sh
bun -e '
import { discoverExamples, runExample } from "./scripts/verify-examples";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.cwd();
const target = mkdtempSync(join(tmpdir(), "sddx-example-01-"));
const result = runExample(root, "01-single-task", target);
console.log(result);
if (!result.ok) process.exit(1);
'
```

Expected: `{ name: "01-single-task", ok: true, message: "" }`. If it fails,
the printed `message` is the exact failing command and observed exit code —
fix the README or setup script, not the harness (the harness itself is
already tested in Task 1).

- [ ] **Step 5: Fix the superseded README teaser link**

`README.md` line 43 currently reads `see
[docs/how-to/install-sddx.md](docs/how-to/install-sddx.md)` from Task 2's
edit — that one stays. Separately, the inline Quickstart script block further
down README.md (the `mkdir demo && cd demo && git init ...` heredoc,
currently ending in `sddx audit`) is superseded by this tutorial; leave it in
place for now — Task 16 replaces the whole Quickstart section in one pass
alongside the Documentation table rewrite, so this task doesn't touch it.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/01-single-task/ docs/tutorials/01-getting-started.md
git commit -m "docs: add getting-started tutorial and its runnable example"
```

---

### Task 8: Tutorial 2 + Example 02 — a parallel multi-task run

**Files:**
- Create: `examples/02-parallel-run/setup.sh` (identical to Task 7's, copied)
- Create: `examples/02-parallel-run/README.md`
- Create: `docs/tutorials/02-your-first-parallel-run.md`
- Delete: `docs/usage.md`
- Modify: `README.md`, `CONTRIBUTING.md` (fix remaining `usage.md` references; replace the inline Quickstart's tail pointer)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/02-parallel-run/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/02-parallel-run/README.md`:

````markdown
# Example: a parallel multi-task run

Two independent tasks — disjoint file scope, no `depends_on` — registered
together from one `graph.yaml`, each getting its own worktree immediately.
This is the primitive `/sddx:run` automates inside Claude Code: an
orchestrator splits a goal into tasks like these, then hands each worktree to
a separate tdd-executor running concurrently. Here both are driven from one
terminal, one after another, so every command stays copy-pasteable — nothing
about the workflow requires that; each worktree's state is fully independent
of the other's.

## Setup

```sh skip
bash examples/02-parallel-run/setup.sh
```

`cd` into the printed directory before running anything below.

## Write two independent specs and the graph

```sh
ROOT="$PWD"
mkdir -p specs
cat > specs/alpha.yaml <<'EOF'
task: alpha module reports its name
success_criteria:
  - "bun test tests/alpha.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/alpha.test.ts"
  expect: exit 0
scope:
  - "src/alpha/**"
EOF
cat > specs/bravo.yaml <<'EOF'
task: bravo module reports its name
success_criteria:
  - "bun test tests/bravo.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/bravo.test.ts"
  expect: exit 0
scope:
  - "src/bravo/**"
EOF
cat > graph.yaml <<'EOF'
goal: add two independent modules
tasks:
  - alias: alpha
    spec: specs/alpha.yaml
  - alias: bravo
    spec: specs/bravo.yaml
EOF
```

## Register the graph

```sh
OUT=$("$ROOT/sddx" graph create --graph graph.yaml)
echo "$OUT"
ALPHA_ID=$(echo "$OUT" | grep -E '^ *alpha →' | awk '{print $3}')
BRAVO_ID=$(echo "$OUT" | grep -E '^ *bravo →' | awk '{print $3}')
```

Two independent worktrees exist right now, before either task is touched:

```sh
test -d "$ROOT/.sddx-worktrees/$ALPHA_ID" && test -d "$ROOT/.sddx-worktrees/$BRAVO_ID"
```

## Drive alpha through the loop, inside its own worktree

```sh
cd "$ROOT/.sddx-worktrees/$ALPHA_ID"
mkdir -p src/alpha tests
cat > tests/alpha.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { alphaName } from "../src/alpha/mod";

test("alpha module reports its name", () => {
  expect(alphaName()).toBe("alpha");
});
EOF
```

```sh expect=1
bun test tests/alpha.test.ts
```

```sh
"$ROOT/sddx" task phase "$ALPHA_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$ALPHA_ID"
cat > src/alpha/mod.ts <<'EOF'
export function alphaName(): string {
  return "alpha";
}
EOF
bun test tests/alpha.test.ts
"$ROOT/sddx" task phase "$ALPHA_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$ALPHA_ID" VERIFY
"$ROOT/sddx" verify "$ALPHA_ID"
```

## Drive bravo the same way, in parallel — here, right after

```sh
cd "$ROOT/.sddx-worktrees/$BRAVO_ID"
mkdir -p src/bravo tests
cat > tests/bravo.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { bravoName } from "../src/bravo/mod";

test("bravo module reports its name", () => {
  expect(bravoName()).toBe("bravo");
});
EOF
```

```sh expect=1
bun test tests/bravo.test.ts
```

```sh
"$ROOT/sddx" task phase "$BRAVO_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$BRAVO_ID"
cat > src/bravo/mod.ts <<'EOF'
export function bravoName(): string {
  return "bravo";
}
EOF
bun test tests/bravo.test.ts
"$ROOT/sddx" task phase "$BRAVO_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$BRAVO_ID" VERIFY
"$ROOT/sddx" verify "$BRAVO_ID"
```

## Check the board from the main checkout

```sh
cd "$ROOT"
"$ROOT/sddx" board
```

Both rows read `Completed` — two tasks, two worktrees, two receipts, zero
merge conflicts in `.sddx/`. Shipping this goal as one PR is
[examples/08-pr-from-goal](../08-pr-from-goal/).
````

- [ ] **Step 3: Write the tutorial**

Create `docs/tutorials/02-your-first-parallel-run.md`:

```markdown
# Your first parallel run

`/sddx:run` — the flagship flow — decomposes a goal into independent tasks
with disjoint file scopes, gives each its own git worktree forked from
`origin/HEAD`, and runs them through the same RED→GREEN→VERIFY loop from
[getting-started.md](01-getting-started.md) concurrently. This tutorial walks
the CLI primitive underneath it: `sddx graph create`. The full commands are a
runnable scaffold at
[examples/02-parallel-run](../../examples/02-parallel-run/).

## Why worktrees, not branches

Two tasks on one branch in one checkout compound: task B's uncommitted state
sits on top of task A's, and a mistake in A silently leaks into B. A
worktree per task forks its own checkout from a shared base commit — each
task's edits, tests, and git history stay physically separate until a human
(or `/sddx:pr`) decides to bring them back together. See
[design-principles.md](../explanation/design-principles.md) principle 3,
"state is files in git" — worktrees are that principle applied to isolation,
not just persistence.

## The graph is the unit of parallel work

A `graph.yaml` lists task nodes — an alias and a path to that task's spec —
with optional `depends_on` edges between them:

```yaml
goal: add two independent modules
tasks:
  - alias: alpha
    spec: specs/alpha.yaml
  - alias: bravo
    spec: specs/bravo.yaml
```

No edges here, so both are roots: `sddx graph create --graph graph.yaml`
validates every spec, checks that any two *unordered* tasks have disjoint
`scope` (the "overlap ⟹ ordered" gate —
[model-dag-dependencies.md](model-dag-dependencies.md) covers the case where
they aren't independent), then creates both worktrees and registers a
**goal** tying the task ids together. Everything is validated before
anything is written — a bad spec in task three of ten refuses the whole
graph rather than leaving two worktrees to clean up by hand.

## Drive each worktree independently

Each worktree is a full, isolated checkout at `.sddx-worktrees/<id>` on
branch `sddx/<id>`. Change into one and it's the same single-task loop from
the previous tutorial — write the failing test, `task phase RED`,
`red-check`, implement, `task phase GREEN`, `verify`. In Claude Code,
`/sddx:run` hands each worktree to its own tdd-executor subagent and they run
genuinely concurrently; from the CLI, "parallel" means "independent," not
literally simultaneous in one terminal — you can drive them in any order, or
interleave commands across both, and neither affects the other's state.

## Check progress with the board

`sddx board` regenerates `.sddx/BOARD.md` — a deterministic table of every
task's phase, workspace, and receipt status across the main checkout *and*
every worktree. Re-run it any time; never hand-edit the file.

## Next

Two independent tasks are the simple case. When one task's work genuinely
depends on another's, that's
[model-dag-dependencies.md](model-dag-dependencies.md).
```

- [ ] **Step 4: Delete usage.md and fix its referrers**

```bash
git rm docs/usage.md
```

In `README.md`'s Documentation table, the `Usage` row:
- Old: `| [Usage](docs/usage.md)                                   | The task loop, `/sddx:run` and `/sddx:quick`, worktrees, the board    |`
- New: `| [Getting started](docs/tutorials/01-getting-started.md)  | The task loop, from spec to receipt, by hand from the CLI             |`

In `docs/explanation/architecture.md`, the two `usage.md` links Task 2
redirected to `../tutorials/02-your-first-parallel-run.md` now resolve to a
real file — no further edit needed here, just confirm it with the grep in
Step 5.

`CONTRIBUTING.md` does not reference `usage.md` (confirmed by Task 2's grep);
no change needed there.

- [ ] **Step 5: Confirm no dangling links to the deleted file**

Run: `grep -rn "docs/usage\.md\|](usage\.md" . --include="*.md" 2>/dev/null | grep -v node_modules`
Expected: no output.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add examples/02-parallel-run/ docs/tutorials/02-your-first-parallel-run.md docs/usage.md README.md
git commit -m "docs: add parallel-run tutorial and its runnable example, retire usage.md"
```

---

### Task 9: How-to + Example 03 — model DAG dependencies

Sourced directly from `tests/deps.e2e.test.ts`'s two fixtures (`scopedGraph`,
`fanInGraph`), combined into one four-task graph so a single `graph create`
call demonstrates both single-parent ordering and two-parent fan-in.

**Files:**
- Create: `examples/03-dag-dependencies/setup.sh` (copy of Task 7's)
- Create: `examples/03-dag-dependencies/README.md`
- Create: `docs/how-to/model-dag-dependencies.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/03-dag-dependencies/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/03-dag-dependencies/README.md`:

````markdown
# Example: modeling DAG dependencies

A four-task graph: `a` and `b` are independent roots; `c` depends on `a`
alone; `d` fans in from both `a` and `b`. Demonstrates the overlap ⟹ ordered
scope gate refusing an illegal schedule, then a legal one materializing
correctly — a single-parent dependent forking from its parent's DONE commit,
and a two-parent fan-in child forking from the first parent and merging the
second in.

## Setup

```sh skip
bash examples/03-dag-dependencies/setup.sh
```

`cd` into the printed directory before running anything below.

## First, watch the gate refuse an illegal graph

Two independent tasks (no `depends_on` between them) whose scopes overlap
are illegal — nothing orders their concurrent writes:

```sh
ROOT="$PWD"
mkdir -p bad-specs
cat > bad-specs/x.yaml <<'EOF'
task: illegal x task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/shared/**"
EOF
cat > bad-specs/y.yaml <<'EOF'
task: illegal y task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/shared/**"
EOF
cat > bad-graph.yaml <<'EOF'
goal: illegal concurrent overlap
tasks:
  - alias: x
    spec: bad-specs/x.yaml
  - alias: y
    spec: bad-specs/y.yaml
EOF
```

```sh
./sddx graph create --graph bad-graph.yaml 2>&1 | grep -q "scope overlap between concurrent tasks"
```

`graph create` validates every spec and the whole schedule **before writing
anything** — this refusal leaves no tasks or worktrees behind, so the sandbox
is still clean for the real graph below.

## Register the real graph

```sh
mkdir -p specs
cat > specs/a.yaml <<'EOF'
task: dag example root a
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/a/**"
EOF
cat > specs/b.yaml <<'EOF'
task: dag example root b
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/b/**"
EOF
cat > specs/c.yaml <<'EOF'
task: dag example single-parent child c
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/a/child.ts"
EOF
cat > specs/d.yaml <<'EOF'
task: dag example fan-in child d
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
scope:
  - "src/d/**"
EOF
cat > graph.yaml <<'EOF'
goal: ship the dashboard
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
  - alias: c
    spec: specs/c.yaml
    depends_on: a
  - alias: d
    spec: specs/d.yaml
    depends_on: [a, b]
EOF
```

`c`'s scope (`src/a/child.ts`) overlaps `a`'s (`src/a/**`) — legal only
because `c depends_on: a` orders them.

```sh
OUT=$(./sddx graph create --graph graph.yaml)
echo "$OUT"
A_ID=$(echo "$OUT" | grep -E '^ *a →' | awk '{print $3}')
B_ID=$(echo "$OUT" | grep -E '^ *b →' | awk '{print $3}')
C_ID=$(echo "$OUT" | grep -E '^ *c →' | awk '{print $3}')
D_ID=$(echo "$OUT" | grep -E '^ *d →' | awk '{print $3}')
```

`a` and `b` get real worktrees immediately; `c` and `d` are deferred — no
worktree yet, both **Blocked** on the board:

```sh
test -d "$ROOT/.sddx-worktrees/$A_ID" && test -d "$ROOT/.sddx-worktrees/$B_ID"
test ! -d "$ROOT/.sddx-worktrees/$C_ID" && test ! -d "$ROOT/.sddx-worktrees/$D_ID"
./sddx board | grep -q "$C_ID | Blocked"
./sddx board | grep -q "$D_ID | Blocked"
```

## Complete a — c becomes ready, d stays blocked on b

```sh
cd "$ROOT/.sddx-worktrees/$A_ID"
"$ROOT/sddx" task phase "$A_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$A_ID"
"$ROOT/sddx" task phase "$A_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$A_ID" VERIFY
"$ROOT/sddx" verify "$A_ID"
cd "$ROOT"
```

```sh
./sddx board | grep -q "$C_ID | Ready"
./sddx board | grep -q "$D_ID | Blocked"
```

## Materialize c — its worktree forks from a's DONE commit

```sh
./sddx task materialize "$C_ID"
```

```sh
[ "$(git -C ".sddx-worktrees/$C_ID" rev-parse HEAD)" = "$(git rev-parse "sddx/$A_ID")" ]
```

## Complete b, then materialize d — a two-parent merge

```sh
cd "$ROOT/.sddx-worktrees/$B_ID"
"$ROOT/sddx" task phase "$B_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$B_ID"
"$ROOT/sddx" task phase "$B_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$B_ID" VERIFY
"$ROOT/sddx" verify "$B_ID"
cd "$ROOT"
```

```sh
./sddx task materialize "$D_ID"
```

`d`'s worktree HEAD is a merge commit with both `a`'s and `b`'s DONE commits
as parents — never a rebase:

```sh
PARENTS=$(git -C ".sddx-worktrees/$D_ID" log -1 --format=%P HEAD)
echo "$PARENTS" | grep -q "$(git rev-parse "sddx/$A_ID")"
echo "$PARENTS" | grep -q "$(git rev-parse "sddx/$B_ID")"
```

## Final board

```sh
./sddx board
```

`a` and `b` read `Completed`; `c` and `d` read `Ready` — materialized, phase
`PLAN`, ready for their own RED→GREEN→VERIFY loop exactly like
[examples/01-single-task](../01-single-task/).
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/model-dag-dependencies.md`:

```markdown
# Model DAG dependencies

`depends_on` in `graph.yaml` turns a flat task set into a general DAG — fan-out
(one parent, several children) **and** fan-in (several parents, one child).
This guide covers the two rules that make it safe, and the two ways a
dependent's workspace gets built. A full runnable walkthrough is
[examples/03-dag-dependencies](../../examples/03-dag-dependencies/).

## The rule: overlap ⟹ ordered

Every pair of tasks a graph does **not** order — including two parents that
both feed the same fan-in child — must have disjoint `scope`. `graph create`
and `goal create` share one checker (`validateSchedule`) that walks every
unordered pair and refuses with `scope overlap between concurrent tasks
"<a>" and "<b>" — order one after the other or make their scopes disjoint`
the moment it finds one. This is checked, atomically, before anything is
created — a violation refuses the whole graph, not just the offending node.

A dependent may legally overlap its *own* ancestor's scope (that's what
`depends_on` buys you): a child scoped `src/a/child.ts` depending on a parent
scoped `src/a/**` is fine, because the edge already orders them.

## Fan-out and fan-in in `graph.yaml`

```yaml
goal: ship the dashboard
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
  - alias: c
    spec: specs/c.yaml
    depends_on: a # fan-out: a single parent
  - alias: d
    spec: specs/d.yaml
    depends_on: [a, b] # fan-in: a list of parents
```

`depends_on` is a bare scalar for one parent or a list for several; a legacy
single-string value still reads correctly either way.

## Deferred creation, then materialize

A task with any `depends_on` entries is created **deferred**: no worktree,
base recorded as `pending:<parent-id>[,...]`, status **Blocked** on the board
until every named parent reaches `DONE`. Once unblocked (status flips to
**Ready**), `sddx task materialize <id>` builds the real workspace:

- **One parent** — the worktree forks directly from that parent's `DONE`
  commit (the tip of `sddx/<parent-id>`).
- **Several parents (fan-in)** — the worktree forks from the *first* parent,
  then sequentially `git merge --no-ff` the rest in. This is safe by
  construction: the graph gate already proved every pair of co-parents has
  disjoint scope, so the merge cannot conflict. A conflict aborts
  materialization loudly rather than auto-resolving — never an octopus merge,
  never a rebase.

`sddx task materialize <id>` refuses with `not DONE` if any named parent
hasn't finished yet.

## Branch mode

The same fan-in mechanics apply in branch mode (`--workspace branch`, or the
automatic submodule fallback — see
[use-branch-mode.md](use-branch-mode.md)): a fan-in merge uses a throwaway
worktree to perform the merge, then removes it — the branch pointer keeps the
merge commit, and no worktree is left behind.
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Spec reference` row:

```
| [Model DAG dependencies](docs/how-to/model-dag-dependencies.md) | Fan-out/fan-in, the overlap ⟹ ordered gate, materialize            |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/03-dag-dependencies/ docs/how-to/model-dag-dependencies.md README.md
git commit -m "docs: add DAG-dependencies how-to guide and its runnable example"
```

---

### Task 10: How-to + Example 04 — configure retry and skip/block

Sourced from `tests/deps.e2e.test.ts`'s retry fixture and `src/board.ts`'s
`skippedOn`/`blockedOn` status derivation.

**Files:**
- Create: `examples/04-retry-and-skip/setup.sh` (copy of Task 7's)
- Create: `examples/04-retry-and-skip/README.md`
- Create: `docs/how-to/configure-retry-and-skip.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/04-retry-and-skip/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/04-retry-and-skip/README.md`:

````markdown
# Example: retry and skip/block policy

Part 1: a task with `retry.max_attempts: 2` resets to `PLAN` instead of
terminating the first time it's abandoned, then truly abandons on the
second. Part 2: once a parent is genuinely `ABANDONED`, its `skip`-policy
dependent shows **Skipped** on the board while its `block`-policy dependent
stays **Blocked**.

## Setup

```sh skip
bash examples/04-retry-and-skip/setup.sh
```

`cd` into the printed directory before running anything below.

## Part 1: a bounded retry

```sh
ROOT="$PWD"
cat > spec.yaml <<'EOF'
task: flaky root task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
retry:
  max_attempts: 2
  workspace: fresh
EOF
OUT=$(./sddx task create --spec spec.yaml --workspace worktree)
echo "$OUT"
ID=$(echo "$OUT" | grep '^created' | awk '{print $2}')
BASE=$(git -C ".sddx-worktrees/$ID" rev-parse HEAD)
```

```sh
cd ".sddx-worktrees/$ID"
"$ROOT/sddx" task phase "$ID" RED --test-exit 1
"$ROOT/sddx" task phase "$ID" GREEN --test-exit 0
```

First abandon: attempts remain, so this **retries** instead of terminating —
watch for `retry 2/2` in the output:

```sh
"$ROOT/sddx" task phase "$ID" ABANDONED 2>&1 | grep -q "retry 2/2"
```

`workspace: fresh` just discarded and recreated the directory we're sitting
in — re-enter it so the shell's own notion of "here" isn't stale:

```sh
cd "$ROOT"
cd ".sddx-worktrees/$ID"
```

```sh
"$ROOT/sddx" task show "$ID" | grep -q '"phase": "PLAN"'
"$ROOT/sddx" task show "$ID" | grep -q '"attempt_count": 2'
```

`workspace: fresh` (the default) re-forked the same worktree back to its
original base — same path, clean history:

```sh
[ "$(git rev-parse HEAD)" = "$BASE" ]
```

Second attempt exhausts the budget — this time it's a real abandon, no
`retry` mention:

```sh
"$ROOT/sddx" task phase "$ID" RED --test-exit 1
"$ROOT/sddx" task phase "$ID" GREEN --test-exit 0
OUT2=$("$ROOT/sddx" task phase "$ID" ABANDONED)
echo "$OUT2"
```

```sh expect=1
echo "$OUT2" | grep -q "retry"
```

```sh
"$ROOT/sddx" task show "$ID" | grep -q '"phase": "ABANDONED"'
cd "$ROOT"
```

## Part 2: skip vs. block once a parent is abandoned

```sh
mkdir -p specs
cat > specs/parent.yaml <<'EOF'
task: unrecoverable parent task
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
EOF
cat > specs/skip-child.yaml <<'EOF'
task: skip-policy dependent
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
EOF
cat > specs/block-child.yaml <<'EOF'
task: block-policy dependent
success_criteria:
  - "true"
oracle:
  type: command
  run: "true"
  expect: exit 0
on_dependency_failure: block
EOF
cat > graph2.yaml <<'EOF'
goal: skip vs block demonstration
tasks:
  - alias: parent
    spec: specs/parent.yaml
  - alias: skip-child
    spec: specs/skip-child.yaml
    depends_on: parent
  - alias: block-child
    spec: specs/block-child.yaml
    depends_on: parent
EOF
```

`skip-child` omits `on_dependency_failure` (default `skip`); `block-child`
sets it explicitly.

```sh
OUT3=$(./sddx graph create --graph graph2.yaml)
echo "$OUT3"
PARENT_ID=$(echo "$OUT3" | grep -E '^ *parent →' | awk '{print $3}')
SKIP_ID=$(echo "$OUT3" | grep -E '^ *skip-child →' | awk '{print $3}')
BLOCK_ID=$(echo "$OUT3" | grep -E '^ *block-child →' | awk '{print $3}')
```

No `retry` in `parent`'s spec, so the first abandon is immediate and final:

```sh
cd ".sddx-worktrees/$PARENT_ID"
"$ROOT/sddx" task phase "$PARENT_ID" RED --test-exit 1
"$ROOT/sddx" task phase "$PARENT_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$PARENT_ID" ABANDONED
cd "$ROOT"
```

```sh
./sddx board >/dev/null && grep -q "$SKIP_ID | Skipped skipped-on-$PARENT_ID" .sddx/BOARD.md
./sddx board >/dev/null && grep -q "$BLOCK_ID | Blocked" .sddx/BOARD.md
```

The rest of a real goal keeps moving past the skip-policy dependent; the
block-policy one stays blocked and escalates.
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/configure-retry-and-skip.md`:

```markdown
# Configure retry and skip/block policy

Two independent spec fields govern what happens when a task can't finish:
`retry` bounds automatic re-attempts of *that task itself*; `on_dependency_failure`
decides what a *dependent* does when a named parent never recovers. A full
runnable walkthrough of both is
[examples/04-retry-and-skip](../../examples/04-retry-and-skip/).

## Retry: bounded re-attempts before ABANDONED

```yaml
retry:
  max_attempts: 2 # default 1 — today's single-attempt behavior
  workspace: fresh # fresh (default) | reuse
```

`sddx task phase <id> ABANDONED` doesn't always abandon: while
`attempt_count < max_attempts`, it resets the task to `PLAN` instead
(`attempt_count` increments, `iterations` and `evidence` clear, `stuck`
clears) — printing `retry <n>/<max_attempts> → phase=PLAN`. Only once
attempts are exhausted does the task actually become `ABANDONED`. `workspace:
fresh` discards and re-forks the worktree/branch from the same base SHA
before the next attempt; `reuse` leaves the existing workspace as-is, mistakes
and all. Retry never reopens an already-`DONE` task — a receipt is immutable
once written.

If a task with a retried-and-already-materialized dependent gets its base
commit superseded (a later retry lands a different commit than the one a
dependent already forked from), sddx discards and re-materializes that
dependent — and, recursively, anything materialized against *it* — from the
new commit. Never a rebase.

## on_dependency_failure: skip vs. block

```yaml
on_dependency_failure: block # default is skip
```

Governs a dependent's reaction once its named parent goes `ABANDONED` (for
good — retries exhausted, or no `retry` at all):

- **`skip`** (default) — the dependent (and, transitively, anything that
  depends on *it*) shows **Skipped** on the board; the rest of the goal keeps
  running.
- **`block`** — the dependent shows **Blocked** and escalates, same as it
  would while simply waiting on an unfinished parent.

Both are read straight off the board (`sddx board`) — no separate command
needed to check status; **Skipped** and **Blocked** are derived at read time
from the task files, never a persisted phase.
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Model DAG
dependencies` row (added in Task 9):

```
| [Configure retry and skip/block](docs/how-to/configure-retry-and-skip.md) | Bounded automatic retry, skip vs block on an abandoned parent |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/04-retry-and-skip/ docs/how-to/configure-retry-and-skip.md README.md
git commit -m "docs: add retry/skip-block how-to guide and its runnable example"
```

---

### Task 11: How-to + Example 05 — use branch mode

**Files:**
- Create: `examples/05-branch-mode/setup.sh` (copy of Task 7's)
- Create: `examples/05-branch-mode/README.md`
- Create: `docs/how-to/use-branch-mode.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/05-branch-mode/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/05-branch-mode/README.md`:

````markdown
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
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/use-branch-mode.md`:

```markdown
# Use branch mode

`worktree` mode (the default under `auto`) gives every task its own
isolated checkout. `branch` mode is the sequential fallback — one
`sddx/<task-id>` branch at a time in the current checkout — for the two
cases worktrees can't safely handle. A full runnable walkthrough is
[examples/05-branch-mode](../../examples/05-branch-mode/).

## When it's used

- **Forced explicitly** — `--workspace branch` on `task create` or `graph
  create`.
- **Automatic fallback under `auto`** — when the repo has git submodules
  (worktrees crossing submodule boundaries are unsafe), or when `git
  worktree` itself is unavailable. Either prints a one-line notice
  (`submodules detected → branch mode` / `git worktree unavailable → branch
  mode`) and proceeds — this is expected behavior, not a refusal.
- **userConfig `workspace_mode: branch`** — force it repo-wide; see
  [config.md](../reference/config.md).

## What's different from worktree mode

Everything else about the loop is identical — the same PLAN→RED→GREEN→VERIFY
phases, the same spec, the same oracle. Only the isolation mechanism
changes: branch mode works sequentially on `sddx/<id>` in the main checkout
instead of a separate directory, so two branch-mode tasks in the same repo
do compound if worked on out of order — finish one before starting the next.

## Dependent materialization in branch mode

A dependent task materializes the same way in branch mode as in worktree
mode, just onto a branch instead of a worktree: a single-parent dependent's
branch points at its parent's `DONE` commit directly; a fan-in dependent's
branch points at a merge commit built the same way — fork from the first
parent, `git merge --no-ff` the rest — using a throwaway worktree internally
to perform the merge, then removing it. The branch pointer keeps the merge
commit; nothing is left behind. See
[model-dag-dependencies.md](model-dag-dependencies.md) for the general
mechanics.
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Configure retry and
skip/block` row (added in Task 10):

```
| [Use branch mode](docs/how-to/use-branch-mode.md)         | The submodule/worktree-unavailable fallback, and forcing it explicitly |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/05-branch-mode/ docs/how-to/use-branch-mode.md README.md
git commit -m "docs: add branch-mode how-to guide and its runnable example"
```

---

### Task 12: How-to + Example 06 — choose an oracle type

`src/lib/oracle.ts`'s `runOracle` executes `oracle.run` via `sh -c` **the
same way regardless of `oracle.type`** — `command`/`test-suite`/`browser`
are mechanically identical; only `type: manual` is special, and
`src/lib/verify.ts` currently throws for it outright (`"manual oracles need
a human decision; M1 verify supports command oracles"`) before it even
checks for red-check evidence. This task documents that honestly instead of
implying all four types are equally usable today.

**Files:**
- Create: `examples/06-oracle-types/setup.sh` (copy of Task 7's)
- Create: `examples/06-oracle-types/README.md`
- Create: `docs/how-to/choose-an-oracle-type.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/06-oracle-types/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/06-oracle-types/README.md`:

````markdown
# Example: oracle types

Proves, rather than just states, that `command`/`test-suite`/`browser`
oracles execute identically — the same `oracle.run` shell command, the same
verifier code path — and shows today's real limitation with `manual`:
`sddx verify` refuses it outright.

## Setup

```sh skip
bash examples/06-oracle-types/setup.sh
```

`cd` into the printed directory before running anything below.

## The three automated types run identically

```sh
ROOT="$PWD"
for TYPE in command test-suite browser; do
  cat > "spec-$TYPE.yaml" <<EOF
task: oracle type demo $TYPE
success_criteria:
  - "ok-$TYPE.txt exists"
oracle:
  type: $TYPE
  run: "test -f ok-$TYPE.txt"
  expect: exit 0
EOF
done
```

(A real `browser` oracle would run something like `bunx playwright test
e2e/login.spec.ts` — this example substitutes a dependency-free stand-in so
it runs fully offline; the mechanics below are identical either way, since
`type` never changes how `run` executes.)

```sh
for TYPE in command test-suite browser; do
  OUT=$(./sddx task create --spec "spec-$TYPE.yaml" --workspace none)
  ID=$(echo "$OUT" | awk '{print $2}')
  echo "$ID" > "id-$TYPE.txt"
  ./sddx task phase "$ID" RED --test-exit 1
  ./sddx red-check "$ID"
  touch "ok-$TYPE.txt"
  ./sddx task phase "$ID" GREEN --test-exit 0
  ./sddx task phase "$ID" VERIFY
  ./sddx verify "$ID"
done
```

All three reach `verdict=pass` through the exact same code path — swapping
`type` never changed the mechanics, only what a reader understands the
command is proving.

## `manual` is accepted, but `verify` refuses it today

```sh
cat > spec-manual.yaml <<'EOF'
task: oracle type demo manual
success_criteria:
  - "a human confirms the page renders correctly"
oracle:
  type: manual
  run: ""
  expect: "human approves the rendered page"
EOF
OUT=$(./sddx task create --spec spec-manual.yaml --workspace none)
MANUAL_ID=$(echo "$OUT" | awk '{print $2}')
./sddx task phase "$MANUAL_ID" RED --test-exit 1
./sddx task phase "$MANUAL_ID" GREEN --test-exit 0
./sddx task phase "$MANUAL_ID" VERIFY
```

```sh
./sddx verify "$MANUAL_ID" 2>&1 | grep -q "manual oracles need a human decision"
```

The spec parser accepts `type: manual` with an empty `run` — registration
never rejects it — but today's verifier refuses to settle it. Until that
changes, a genuinely non-automatable outcome needs a different oracle
shaped as a proxy check (a file a human touches after reviewing, a status
endpoint a human flips) rather than `type: manual` itself.
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/choose-an-oracle-type.md`:

```markdown
# Choose an oracle type

Four `oracle.type` values exist in the spec schema, but they aren't four
different execution paths — three are the same mechanism with different
intent, and the fourth doesn't work yet. A full runnable proof of both facts
is [examples/06-oracle-types](../../examples/06-oracle-types/).

## `command`, `test-suite`, `browser` are mechanically identical

`src/lib/oracle.ts` runs `oracle.run` through `sh -c` and checks the exit
code against `oracle.expect` — every automated type goes through this exact
same function. The `type` field changes nothing about execution; it exists
so a reader of the spec (human or model) understands *what kind* of proof
`run` is, not to select different verifier behavior:

```yaml
oracle: # command — any shell command; the default choice
  type: command
  run: "curl -sf localhost:3000/health"
  expect: exit 0
```

```yaml
oracle: # test-suite — the project's test runner as the proof
  type: test-suite
  run: "bun test"
  expect: exit 0
```

```yaml
oracle: # browser — a scripted browser check (e.g. Playwright)
  type: browser
  run: "bunx playwright test e2e/login.spec.ts"
  expect: exit 0
```

Prefer `command`/`test-suite` for anything a shell command can decide — the
proof is mechanical either way. Reach for `browser` only when the thing
being proven genuinely requires a rendered page (a scripted Playwright/
Puppeteer run, still just a shell command from sddx's point of view).

## `manual` is accepted but not yet verifiable

```yaml
oracle: # manual — a human signs off; run may be empty
  type: manual
  run: ""
  expect: "human approves the rendered page"
```

The spec parser accepts this shape — `run` isn't required when `type` is
`manual` — but `sddx verify` currently throws `"manual oracles need a human
decision; M1 verify supports command oracles"` for any manual-oracle task,
unconditionally. A manual-oracle task can be created and driven through
`RED`/`GREEN`, but cannot currently reach `DONE` through `sddx verify`.

Until manual verification ships, model a genuinely non-automatable outcome
as a proxy check instead — a file a human creates after reviewing, an
approval flag a human flips, anything a `command` oracle can observe — and
keep `type: command`.

## `oracle.runs`

Independent of `type`: `runs` (integer ≥ 1, default from userConfig
`oracle_runs_default`) makes `sddx verify` execute the oracle that many times
sequentially, and **every** run must pass — a flakiness check, not a type.
See [spec-reference.md](../reference/spec-reference.md#oracle).
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Use branch mode` row
(added in Task 11):

```
| [Choose an oracle type](docs/how-to/choose-an-oracle-type.md) | Why command/test-suite/browser are identical, and manual's real limit |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/06-oracle-types/ docs/how-to/choose-an-oracle-type.md README.md
git commit -m "docs: add oracle-types how-to guide and its runnable example"
```

---

### Task 13: Example 07 — receipts and audit

The how-to guide for this topic already exists (`docs/how-to/verify-and-audit-receipts.md`,
written in Task 3) — this task adds its runnable counterpart and links it in.

**Files:**
- Create: `examples/07-receipts-and-audit/setup.sh` (copy of Task 7's)
- Create: `examples/07-receipts-and-audit/README.md`
- Modify: `docs/how-to/verify-and-audit-receipts.md` (the link to this example, added in Task 3, already points here — confirm it in Step 3)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/07-receipts-and-audit/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/07-receipts-and-audit/README.md`:

````markdown
# Example: receipts and audit

Completes one task, inspects its receipt, runs `sddx audit` clean, then
deliberately tampers with the receipt file and watches audit catch it —
loudly, not silently — before restoring it and confirming the chain is
intact again.

## Setup

```sh skip
bash examples/07-receipts-and-audit/setup.sh
```

`cd` into the printed directory before running anything below.

## Complete one task

```sh
cat > spec.yaml <<'EOF'
task: receipts example task
context: []
success_criteria:
  - "ok.txt exists"
oracle:
  type: command
  run: "test -f ok.txt"
  expect: exit 0
out_of_scope: []
EOF
OUT=$(./sddx task create --spec spec.yaml --workspace none)
echo "$OUT"
ID=$(echo "$OUT" | awk '{print $2}')
./sddx task phase "$ID" RED --test-exit 1
./sddx red-check "$ID"
touch ok.txt
./sddx task phase "$ID" GREEN --test-exit 0
./sddx task phase "$ID" VERIFY
./sddx verify "$ID"
```

## Inspect the receipt

```sh
cat ".sddx/receipts/$ID.json"
```

```sh
grep -o '"verdict": "pass"' ".sddx/receipts/$ID.json"
grep -o '"task_id": "'"$ID"'"' ".sddx/receipts/$ID.json"
```

(Receipts are written with `JSON.stringify(receipt, null, 2)` — a space
always follows each `:` in that output. If a future receipt format changes
this, adjust the grep pattern to match, not the other way round.)

## A clean audit

```sh
./sddx audit 2>&1 | grep -q "chain intact"
```

## Tamper with it, and watch audit catch it

```sh
sed -i.bak 's/"exit_code": 0/"exit_code": 1/' ".sddx/receipts/$ID.json"
rm -f ".sddx/receipts/$ID.json.bak"
```

```sh
./sddx audit 2>&1 | grep -q "tampered"
```

## Restore it, and confirm the chain is intact again

```sh
git checkout -- ".sddx/receipts/$ID.json"
```

```sh
./sddx audit 2>&1 | grep -q "chain intact"
```

The receipt was never re-written to fix the tamper — it was restored to its
committed bytes. Receipts are immutable; the only legitimate way to change
one is to never have written the wrong one, which is exactly what the hash
chain exists to prove after the fact.
````

- [ ] **Step 3: Confirm the how-to guide's link resolves**

`docs/how-to/verify-and-audit-receipts.md` (written in Task 3) already
contains: `a full runnable walkthrough — including deliberately tampering
with a receipt and watching audit catch it — is in
[examples/07-receipts-and-audit](../../examples/07-receipts-and-audit/).`
No edit needed; this step is just confirming the target now exists.

Run: `test -f docs/how-to/verify-and-audit-receipts.md && test -d examples/07-receipts-and-audit`
Expected: exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/07-receipts-and-audit/
git commit -m "docs: add the receipts-and-audit runnable example"
```

---

### Task 14: How-to + Example 08 — ship a goal as a PR

`sddx pr create` pushes to a real remote and shells out to `gh`/`glab` —
this example never actually invokes it (no network calls, per this plan's
Global Constraints). It demonstrates the two **local, pure** refusal paths
instead — an incomplete goal, and an undetectable PR host — both taken
directly from `src/lib/pr.ts`/`src/lib/prhost.ts`, and marks the real command
`skip` (shown, not executed) for illustration.

**Files:**
- Create: `examples/08-pr-from-goal/setup.sh` (copy of Task 7's)
- Create: `examples/08-pr-from-goal/README.md`
- Create: `docs/how-to/ship-a-goal-as-a-pr.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/08-pr-from-goal/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/08-pr-from-goal/README.md`:

````markdown
# Example: shipping a goal as a PR

`sddx pr create` refuses loudly, before any git mutation, in two ways this
example proves directly: an incomplete goal, and a host it can't resolve.
Both are pure and local — no network call happens in either case. The real
command (push + `gh`/`glab`) is shown at the end for reference, but not run.

## Setup

```sh skip
bash examples/08-pr-from-goal/setup.sh
```

`cd` into the printed directory before running anything below.

## Register a two-task goal

```sh
ROOT="$PWD"
mkdir -p specs
cat > specs/a.yaml <<'EOF'
task: pr example task a
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
task: pr example task b
success_criteria:
  - "b.done exists"
oracle:
  type: command
  run: "test -f b.done"
  expect: exit 0
scope:
  - "src/b/**"
EOF
cat > graph.yaml <<'EOF'
goal: ship two tasks together
tasks:
  - alias: a
    spec: specs/a.yaml
  - alias: b
    spec: specs/b.yaml
EOF
OUT=$(./sddx graph create --graph graph.yaml)
echo "$OUT"
GOAL_ID=$(echo "$OUT" | grep -o 'created goal [^ ]*' | awk '{print $3}')
A_ID=$(echo "$OUT" | grep -E '^ *a →' | awk '{print $3}')
B_ID=$(echo "$OUT" | grep -E '^ *b →' | awk '{print $3}')
```

## Refusal 1: an incomplete goal

Complete only `a`:

```sh
cd ".sddx-worktrees/$A_ID"
"$ROOT/sddx" task phase "$A_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$A_ID"
touch a.done
"$ROOT/sddx" task phase "$A_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$A_ID" VERIFY
"$ROOT/sddx" verify "$A_ID"
cd "$ROOT"
```

```sh
./sddx pr create --goal "$GOAL_ID" 2>&1 | grep -q "is not complete — blocking: $B_ID"
```

No branch was created, nothing was pushed — the refusal happens before any
git mutation.

## Refusal 2: an undetectable PR host

Finish `b` too:

```sh
cd ".sddx-worktrees/$B_ID"
"$ROOT/sddx" task phase "$B_ID" RED --test-exit 1
"$ROOT/sddx" red-check "$B_ID"
touch b.done
"$ROOT/sddx" task phase "$B_ID" GREEN --test-exit 0
"$ROOT/sddx" task phase "$B_ID" VERIFY
"$ROOT/sddx" verify "$B_ID"
cd "$ROOT"
```

This sandbox has no `origin` remote (`setup.sh` never added one), so even a
fully complete goal is refused — again, before any git mutation:

```sh
./sddx pr create --goal "$GOAL_ID" 2>&1 | grep -q 'cannot determine PR host from the "origin" remote'
```

Setting `userConfig.pr_host` (`gh` or `glab`) — see
[tune-config.md](../../docs/how-to/tune-config.md) — or having a recognized
`origin` remote (`github.com` or `gitlab.com`) resolves this without
changing anything else about the flow.

## What a real invocation does (not run here)

With a real `origin` remote and an authenticated `gh`/`glab`:

```sh skip
sddx pr create --goal "$GOAL_ID"
```

Cherry-picks each task's atomic commit (task-creation order) onto a fresh
`sddx/goal-$GOAL_ID` branch, pushes it, and opens the PR with a body
generated from the tasks' receipts — never hand-written. On success it marks
every task and the goal `shipped`, which is what lets `sddx cleanup` later
remove a cherry-picked task branch despite it never looking git-merged by
ancestry.
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/ship-a-goal-as-a-pr.md`:

```markdown
# Ship a goal as a PR

`sddx pr create --goal <goal-id>` opens **one PR per goal**: every task in
the goal cherry-picked onto a single branch, with a body generated from the
tasks' receipts. It's a deliberately separate, explicitly-invoked command —
`/sddx:run` never calls it automatically, the same way it never merges
branches automatically. The two refusal paths below are fully local and
network-free — a full runnable proof is
[examples/08-pr-from-goal](../../examples/08-pr-from-goal/).

## All-or-nothing

Refuses unless every task in the goal is `DONE` with a passing receipt,
re-checked fresh at invocation time — not cached from when the goal was
created:

```
goal <id> is not complete — blocking: <task-id> (phase <phase>)
```

## Resolving the host

`pr_host` (userConfig — see [config.md](../reference/config.md)) picks `gh`
or `glab` explicitly; unset, it's detected from the `origin` remote
(`github.com` → `gh`, `gitlab.com` → `glab`). Neither configured nor
detectable refuses before touching git:

```
cannot determine PR host from the "origin" remote — set userConfig.pr_host to "gh" or "glab"
```

An unauthenticated host CLI refuses the same way, one step later (after the
host is resolved, before any push): `<host> is not authenticated: <message>`.

## What happens on success

Cherry-picks each task's atomic commit onto a fresh `sddx/goal-<goal-id>`
branch (task-creation order, never a merge commit), pushes it, and opens the
PR (or, on GitLab, the merge request — same command name, same mechanics,
only the host object's name differs) via the resolved host CLI. On success,
writes a `shipped` marker onto every task's branch and the goal file — the
second, equally valid proof `sddx cleanup` accepts for a task branch that
will never look git-merged by ancestry, since its commit was cherry-picked,
not merged.

A cherry-pick conflict refuses loudly too, naming the task whose commit
failed — no partial branch is left pushed.
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Choose an oracle
type` row (added in Task 12):

```
| [Ship a goal as a PR](docs/how-to/ship-a-goal-as-a-pr.md) | All-or-nothing gating, host resolution, what `pr create` actually does |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/08-pr-from-goal/ docs/how-to/ship-a-goal-as-a-pr.md README.md
git commit -m "docs: add ship-a-goal-as-a-pr how-to guide and its runnable example"
```

---

### Task 15: How-to + Example 09 — tune config

**Files:**
- Create: `examples/09-config-tuning/setup.sh` (copy of Task 7's)
- Create: `examples/09-config-tuning/README.md`
- Create: `docs/how-to/tune-config.md`
- Modify: `README.md` (add Documentation row)

**Interfaces:** None.

- [ ] **Step 1: Copy the setup script**

```bash
cp examples/01-single-task/setup.sh examples/09-config-tuning/setup.sh
```

- [ ] **Step 2: Write the example README**

Create `examples/09-config-tuning/README.md`:

````markdown
# Example: tuning config

Defaults, an override in `.sddx/config.json`, an environment variable
winning over that override, `config validate`'s warnings, and the one case
it fails outright.

## Setup

```sh skip
bash examples/09-config-tuning/setup.sh
```

`cd` into the printed directory before running anything below.

## Defaults

```sh
./sddx config show | grep -q "^stuck_threshold: 3$"
./sddx config show | grep -q "^workspace_mode: auto$"
```

## Override via `.sddx/config.json`

```sh
mkdir -p .sddx
cat > .sddx/config.json <<'EOF'
{
  "workspace_mode": "branch",
  "stuck_threshold": 5,
  "verbose": true
}
EOF
./sddx config show | grep -q "^workspace_mode: branch$"
./sddx config show | grep -q "^stuck_threshold: 5$"
```

`verbose: true` adds a resolution-detail block naming which source won for
each key:

```sh
./sddx config show | grep -q "resolution detail"
./sddx config show | grep -q "stuck_threshold: source=config"
```

## An environment variable outranks the config file

```sh
SDDX_STUCK_THRESHOLD=7 ./sddx config show | grep -q "^stuck_threshold: 7$"
```

## `config validate`'s warnings (never a hard failure for a valid file)

```sh
cat > .sddx/config.json <<'EOF'
{
  "workspace_mode": "sideways",
  "totally_unknown_key": true
}
EOF
```

```sh
./sddx config validate 2>&1 | grep -q 'warning: "workspace_mode" must be one of'
./sddx config validate 2>&1 | grep -q 'warning: unrecognized key "totally_unknown_key"'
```

## Unparseable JSON is the one case that fails outright

```sh
echo '{ not json' > .sddx/config.json
```

```sh
./sddx config validate 2>&1 | grep -q "is not valid JSON"
```

```sh
rm .sddx/config.json
```

## Structured output for automation

```sh
./sddx config show --output json | grep -o '"stuck_threshold": [0-9]*'
```
````

- [ ] **Step 3: Write the how-to guide**

Create `docs/how-to/tune-config.md`:

```markdown
# Tune config

Every `userConfig` key, its env var, and its default are in
[config.md](../reference/config.md). This guide is the mechanics: where to
put an override, what wins when several sources disagree, and what
`sddx config validate` actually checks. A full runnable walkthrough is
[examples/09-config-tuning](../../examples/09-config-tuning/).

## Where overrides live

Inside Claude Code, enabling the plugin prompts for these settings and
materializes them into `.sddx/config.json` — there's nothing to hand-edit.
Outside Claude Code, write `.sddx/config.json` yourself:

```json
{
  "workspace_mode": "branch",
  "stuck_threshold": 5
}
```

## Precedence

Environment variable → `.sddx/config.json` → built-in default, highest
first. Only some keys have an environment variable at all (see the table in
[config.md](../reference/config.md)) — setting `SDDX_STUCK_THRESHOLD=7`
outranks a config-file `stuck_threshold`, but there's no equivalent variable
for `workspace_mode`.

## Seeing what won

`sddx config show` prints every key fully resolved. Set `verbose: true` and
it also prints, per key, which source actually won (`env`, `config`, or
`default`) — the one place `verbose` changes `terminal` output; `--output
json`/`--output markdown` already carry the fully-resolved values regardless
of `verbose`.

## Validating without guessing

`sddx config validate` checks `.sddx/config.json` against the schema and
reports unrecognized keys and out-of-domain values (not just wrong
`typeof` — `stuck_threshold: -2` and a typo'd `workspace_mode` are both
caught) as **warnings** — exit 0, since a structurally-parseable file with a
bad key shouldn't block anything. The one case that fails outright (exit 1)
is unparseable JSON, or JSON that isn't an object — that's a broken file, not
a schema disagreement. A missing `.sddx/config.json` is not an error either
way; built-in defaults apply.
```

- [ ] **Step 4: Add the README Documentation row**

In `README.md`'s Documentation table, insert after the `Ship a goal as a PR`
row (added in Task 14):

```
| [Tune config](docs/how-to/tune-config.md)                 | Where overrides live, precedence, `config validate`'s warnings         |
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/09-config-tuning/ docs/how-to/tune-config.md README.md
git commit -m "docs: add config-tuning how-to guide and its runnable example"
```

---

### Task 16: Wire permanent CI coverage, examples index, final README rewrite

**Files:**
- Create: `examples/README.md`
- Create: `tests/examples.e2e.test.ts`
- Modify: `.gitignore` (ignore each example's local `.sandbox/`)
- Modify: `.github/workflows/ci.yml` (the `links` job's lychee glob)
- Modify: `README.md` (replace the inline Quickstart section and the whole Documentation table)

**Interfaces:**
- Consumes: `discoverExamples`/`runExample` from Task 1 (`scripts/verify-examples.ts`); `repoRoot` from `tests/helpers.ts`.

- [ ] **Step 1: Write the examples index**

Create `examples/README.md`:

```markdown
# sddx examples

One runnable scaffold per major feature — `cd` into any of these, run its
`setup.sh`, and follow its `README.md`. Every command shown is copy-paste
real; the same commands are replayed by `tests/examples.e2e.test.ts` in CI,
so an example that stops working is a test failure, not stale prose.

| Example | Feature | Docs |
| --- | --- | --- |
| [01-single-task](01-single-task/) | The base loop, one task, no worktree | [Getting started](../docs/tutorials/01-getting-started.md) |
| [02-parallel-run](02-parallel-run/) | Independent tasks, parallel worktrees | [Your first parallel run](../docs/tutorials/02-your-first-parallel-run.md) |
| [03-dag-dependencies](03-dag-dependencies/) | Fan-out/fan-in, the overlap ⟹ ordered gate | [Model DAG dependencies](../docs/how-to/model-dag-dependencies.md) |
| [04-retry-and-skip](04-retry-and-skip/) | Bounded retry, skip vs block | [Configure retry and skip/block](../docs/how-to/configure-retry-and-skip.md) |
| [05-branch-mode](05-branch-mode/) | The submodule fallback, forcing branch mode | [Use branch mode](../docs/how-to/use-branch-mode.md) |
| [06-oracle-types](06-oracle-types/) | The four oracle types, and manual's real limit | [Choose an oracle type](../docs/how-to/choose-an-oracle-type.md) |
| [07-receipts-and-audit](07-receipts-and-audit/) | Inspecting, auditing, and tampering with a receipt | [Verify and audit receipts](../docs/how-to/verify-and-audit-receipts.md) |
| [08-pr-from-goal](08-pr-from-goal/) | `pr create`'s local refusal paths | [Ship a goal as a PR](../docs/how-to/ship-a-goal-as-a-pr.md) |
| [09-config-tuning](09-config-tuning/) | Precedence, `config validate`'s warnings | [Tune config](../docs/how-to/tune-config.md) |

Each `setup.sh` accepts an optional target-directory argument — defaults to
a gitignored `.sandbox/` next to the script for a convenient local run; the
test suite passes its own scratch directory instead.
```

- [ ] **Step 2: Write the failing coverage test**

Create `tests/examples.e2e.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExamples, runExample } from "../scripts/verify-examples";
import { repoRoot } from "./helpers";

const EXPECTED = [
  "01-single-task",
  "02-parallel-run",
  "03-dag-dependencies",
  "04-retry-and-skip",
  "05-branch-mode",
  "06-oracle-types",
  "07-receipts-and-audit",
  "08-pr-from-goal",
  "09-config-tuning",
];

describe("runnable examples", () => {
  test("every documented feature has a runnable example, none silently missing", () => {
    expect(discoverExamples(repoRoot)).toEqual(EXPECTED);
  });

  for (const name of EXPECTED) {
    test(`${name} runs exactly as documented`, () => {
      const target = mkdtempSync(join(tmpdir(), `sddx-example-${name}-`));
      const result = runExample(repoRoot, name, target);
      expect(result.ok, result.message).toBe(true);
    });
  }
});
```

This is the permanent version of Task 7 Step 4's one-off manual check — from
here on, `bun test` (already part of the `test` CI job) covers all nine
examples on every push, with no build step (dist/cli.mjs is committed).

- [ ] **Step 3: Run it to confirm it passes**

Run: `bun test tests/examples.e2e.test.ts`
Expected: PASS — 10 tests (the coverage-list assertion plus one per
example), all green, confirming every example built in Tasks 7-15 still
works end to end.

- [ ] **Step 4: Ignore the local sandbox directories**

Add to `.gitignore` (a new line under the existing `# deps` section or its
own section):

```
# sddx examples (local runs only — CI uses its own scratch dir)
examples/*/.sandbox/
```

- [ ] **Step 5: Add examples to the docs link checker**

In `.github/workflows/ci.yml`'s `links` job, extend the lychee `args` to
also check example READMEs:

Old:
```
          args: --offline --no-progress README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md 'docs/**/*.md'
```

New:
```
          args: --offline --no-progress README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md 'docs/**/*.md' 'examples/**/*.md'
```

- [ ] **Step 6: Replace README.md's Quickstart section**

Read the current `README.md`, find the `## Quickstart (first verified task
in ~5 minutes)` section (the inline `mkdir demo && cd demo ...` heredoc
script and its following paragraph, ending right before `## Documentation`),
and replace the whole section with:

```markdown
## Quickstart

```sh
mkdir demo && cd demo && git init
git commit --allow-empty -m init
```

Then follow [Getting started](docs/tutorials/01-getting-started.md) — the
same loop `/sddx:quick`/`--solo` drive inside Claude Code, one command at a
time, ending in a verified receipt. Every command there (and in every guide
below) is also a copy-paste-able scaffold under
[examples/](examples/README.md).
```

- [ ] **Step 7: Replace README.md's entire Documentation table**

Read the current `README.md`'s `## Documentation` section (its row set has
been edited incrementally across Tasks 2-15; read the file to see its actual
current rows before editing) and replace the whole section — heading through
the table's last row — with:

```markdown
## Documentation

**New to sddx?**

- [Getting started](docs/tutorials/01-getting-started.md) — your first verified task, by hand from the CLI
- [Your first parallel run](docs/tutorials/02-your-first-parallel-run.md) — two tasks, two worktrees

**How-to guides**

- [Install sddx](docs/how-to/install-sddx.md)
- [Model DAG dependencies](docs/how-to/model-dag-dependencies.md)
- [Configure retry and skip/block](docs/how-to/configure-retry-and-skip.md)
- [Use branch mode](docs/how-to/use-branch-mode.md)
- [Choose an oracle type](docs/how-to/choose-an-oracle-type.md)
- [Verify and audit receipts](docs/how-to/verify-and-audit-receipts.md)
- [Ship a goal as a PR](docs/how-to/ship-a-goal-as-a-pr.md)
- [Tune config](docs/how-to/tune-config.md)
- [Troubleshooting](docs/how-to/troubleshoot-common-problems.md)

**Reference**

- [Spec reference](docs/reference/spec-reference.md)
- [CLI reference](docs/reference/cli.md)
- [Hooks & the TDD gate](docs/reference/hooks.md)
- [Receipts schema](docs/reference/receipts-schema.md)
- [Config reference](docs/reference/config.md)

**Understand the design**

- [Why sddx](docs/explanation/why-sddx.md)
- [Design principles](docs/explanation/design-principles.md)
- [How it compares](docs/explanation/how-it-compares.md)
- [Architecture](docs/explanation/architecture.md)

**Runnable examples**

- [examples/](examples/README.md) — one scaffold per feature above, replayed in CI

**Project**

- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)
```

- [ ] **Step 8: Confirm no dangling or duplicate links**

Run: `grep -rn "docs/installation\.md\b\|docs/hooks\.md\b\|docs/cli\.md\b\|docs/architecture\.md\b\|docs/troubleshooting\.md\b\|docs/usage\.md\b\|docs/spec-reference\.md\b\|docs/receipts-and-audit\.md\b" README.md`
Expected: no output — every one of these old top-level paths was relocated
in Tasks 2-4 and 8; if any remain in README.md's rewritten sections, fix them.

- [ ] **Step 9: Run every check this repo runs in CI**

Run, in order:

```sh
bun test
bun run typecheck
biome check .
pre-commit run --all-files
```

Expected: all four exit 0. If `pre-commit` isn't installed locally, skip it
here — it runs in CI regardless (per `CONTRIBUTING.md`); everything else
must pass locally.

If `lychee` is installed locally, also run:

```sh
lychee --offline --no-progress README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md 'docs/**/*.md' 'examples/**/*.md'
```

Expected: no broken intra-repo links. If `lychee` isn't installed, this
still runs in the `links` CI job on push — not a local blocker.

- [ ] **Step 10: Commit**

```bash
git add examples/README.md tests/examples.e2e.test.ts .gitignore .github/workflows/ci.yml README.md
git commit -m "docs: wire permanent CI coverage for all nine examples, finish README rewrite"
```
