// The boundary proof: shows, from git and the oracle alone, that a task's tests
// catch its change (RED: the oracle fails on the base commit plus only the
// changed test files) and that the change makes them pass (GREEN: the oracle
// passes on the exact verified tree). Both halves run in one throwaway proof
// worktree, so a broken environment can only make verify fail, never pass: a
// missing dependency that fakes a RED also fails the GREEN.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClassifyConfig, classify } from "./classify";
import { git } from "./git";
import { runOracle } from "./oracle";
import { type OracleRun, sha256 } from "./receipt";
import type { Oracle } from "./spec";
import type { VerifiedRecord } from "./task";
import {
  gitCommonDir,
  listSddxWorktrees,
  PROOF_SUFFIX,
  proofLockReason,
  proofOwner,
  removeScratchWorktree,
  worktreesDir,
} from "./worktree";

/** sddx's own state, never part of what verify proves or review binds to. */
export const STATE_EXCLUDE = ":(exclude).sddx";

/**
 * The git tree of a worktree's full content: tracked changes and new untracked
 * files, minus ignored files and uncommitted `.sddx/` changes. Built in a
 * temporary index seeded from HEAD, so neither the worktree's files nor its
 * real index change.
 */
export function worktreeTree(worktree: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sddx-tree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const run = (args: string[]): string => {
    const r = spawnSync("git", args, { cwd: worktree, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  try {
    run(["read-tree", "HEAD"]);
    run(["add", "-A", "--", ".", STATE_EXCLUDE]);
    return run(["write-tree"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ChangedFile {
  /** `M` covers every change that leaves a path in the tree, a type change included. */
  status: "A" | "M" | "D";
  path: string;
}

/** NUL-separated `git diff -z` output, so paths arrive unquoted whatever they contain. */
function diffZ(cwd: string, args: string[]): string[] {
  const r = spawnSync("git", ["diff", "-z", "--no-renames", "--no-ext-diff", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git diff failed: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").split("\0").filter((f) => f !== "");
}

/** Files that differ between two trees, outside `.sddx/`. Renames are reported
 * as a deletion plus an addition so each side is classified on its own. */
export function changedFiles(cwd: string, base: string, tree: string): ChangedFile[] {
  const fields = diffZ(cwd, ["--name-status", base, tree, "--", ".", STATE_EXCLUDE]);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] as string;
    const path = fields[i + 1] as string;
    files.push({ status: status === "A" ? "A" : status === "D" ? "D" : "M", path });
  }
  return files;
}

/** Paths under `.sddx/` that differ between two trees. sddx alone writes there,
 * and only at finalize, so any such change in a task's tree is out of bounds. */
export const sddxChanges = (cwd: string, base: string, tree: string): string[] =>
  diffZ(cwd, ["--name-only", base, tree, "--", ".sddx"]);

/** Runs a git command on literal paths read from stdin, so no path is read as pathspec magic. */
function gitOnPaths(cwd: string, args: string[], paths: string[]): void {
  const r = spawnSync(
    "git",
    ["--literal-pathspecs", ...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
    { cwd, input: `${paths.join("\0")}\0`, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
}

export function changedTestFiles(
  cwd: string,
  base: string,
  tree: string,
  config: ClassifyConfig,
): ChangedFile[] {
  return changedFiles(cwd, base, tree).filter((f) => classify(f.path, [], config).rule === "test");
}

/** sha256 of the binary diff from base to tree, outside `.sddx/`: what a review binds to. */
export function diffSha256(cwd: string, base: string, tree: string): string {
  const r = spawnSync("git", ["diff", "--binary", base, tree, "--", ".", STATE_EXCLUDE], {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr?.toString().trim()}`);
  return sha256(r.stdout);
}

const expectedExit = (expect: string): number => {
  const m = /^exit\s+(\d+)$/.exec(expect.trim());
  if (!m) throw new Error(`unsupported oracle.expect: "${expect}" (expected "exit <code>")`);
  return Number(m[1]);
};

export type ProofResult =
  | {
      ok: true;
      testFiles: string[];
      red: { exit_code: number; stdout_sha256: string; stderr_sha256: string };
      green: OracleRun[];
    }
  | {
      ok: false;
      half: "red" | "green" | "setup";
      exitCode: number;
      message: string;
      testFiles: string[];
      /** Fingerprint of the failure, for stuck detection. */
      fingerprint: string;
      green: OracleRun[];
    };

/**
 * Identity of a failure for stuck detection: which half, the exit code, and the
 * last 20 lines of output with numbers and whitespace normalized away. Test
 * runners print durations, so hashing raw output would make every repeat of the
 * same failure look new and a stuck task would never be flagged.
 */
export function failureFingerprint(half: string, exitCode: number, output: Buffer): string {
  const tail = output
    .toString("utf8")
    .split("\n")
    .slice(-20)
    .join("\n")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(`${half}\0${exitCode}\0${tail}`);
}

export const proofPath = (root: string, id: string): string =>
  join(worktreesDir(root), `${id}${PROOF_SUFFIX}`);

/**
 * What a passing `sddx verify` proved, kept in the git directory rather than in
 * the task file. The task file sits in the worktree an agent edits, so review
 * and finalize trust only this record, which is bound to the task's attempt.
 */
export interface ProofRecord extends VerifiedRecord {
  task_id: string;
  attempt: number;
  /** The oracle verify ran, already checked against the approved spec. */
  oracle: Oracle;
}

const proofRecordPath = (root: string, id: string): string =>
  join(gitCommonDir(root), "sddx-proofs", `${id}.json`);

export function writeProofRecord(root: string, record: ProofRecord): void {
  const path = proofRecordPath(root, record.task_id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** The record for the task's current attempt, or null when verify has not passed it. */
export function readProofRecord(root: string, id: string, attempt: number): ProofRecord | null {
  try {
    const r = JSON.parse(readFileSync(proofRecordPath(root, id), "utf8")) as ProofRecord;
    return r.task_id === id && r.attempt === attempt ? r : null;
  } catch {
    return null;
  }
}

export function clearProofRecord(root: string, id: string): void {
  rmSync(proofRecordPath(root, id), { force: true });
}

/** Clears the way for a new proof worktree, refusing while another verify of the task owns it. */
function claimProofPath(root: string, id: string, path: string): void {
  const existing = listSddxWorktrees(root).find((w) => w.path === path);
  const owner = proofOwner(existing?.locked ?? null);
  if (owner.alive) {
    throw new Error(
      `a verify of ${id} is already running${owner.pid ? ` (pid ${owner.pid})` : ""}. If none is, remove its proof worktree: git worktree remove --force --force ${path}`,
    );
  }
  if (existing || existsSync(path)) removeScratchWorktree(root, path);
}

function runSetup(path: string, setup: string | undefined): { ok: boolean; exitCode: number } {
  if (!setup) return { ok: true, exitCode: 0 };
  const r = runOracle(path, setup);
  return { ok: r.exitCode === 0, exitCode: r.exitCode };
}

/**
 * Runs both halves of the boundary proof for one task. The proof worktree is
 * created detached at `base` and removed when the proof ends, whatever the
 * outcome.
 */
export function runBoundaryProof(opts: {
  root: string;
  id: string;
  base: string;
  tree: string;
  oracle: Oracle;
  runs: number;
  classify: ClassifyConfig;
}): ProofResult {
  const { root, id, base, tree, oracle } = opts;
  const want = expectedExit(oracle.expect);
  const tests = changedTestFiles(root, base, tree, opts.classify);
  const testFiles = tests.map((t) => t.path);
  const path = proofPath(root, id);
  claimProofPath(root, id, path);
  // locked so a concurrent sweep can tell this proof is live
  git(
    root,
    "worktree",
    "add",
    "-q",
    "--detach",
    "--lock",
    "--reason",
    proofLockReason(),
    path,
    base,
  );
  try {
    const added = tests.filter((t) => t.status !== "D").map((t) => t.path);
    const deleted = tests.filter((t) => t.status === "D").map((t) => t.path);
    if (added.length > 0) gitOnPaths(path, ["checkout", tree], added);
    if (deleted.length > 0) gitOnPaths(path, ["rm", "-q"], deleted);

    const fail = (
      half: "red" | "green" | "setup",
      exitCode: number,
      message: string,
      output: Buffer,
      green: OracleRun[] = [],
    ): ProofResult => ({
      ok: false,
      half,
      exitCode,
      message,
      testFiles,
      fingerprint: failureFingerprint(half, exitCode, output),
      green,
    });

    const redSetup = runSetup(path, oracle.setup);
    if (!redSetup.ok) {
      return fail(
        "setup",
        redSetup.exitCode,
        `oracle.setup exited ${redSetup.exitCode} on the base commit`,
        Buffer.alloc(0),
      );
    }
    const red = runOracle(path, oracle.run);
    if (red.exitCode === want) {
      return fail(
        "red",
        red.exitCode,
        `the oracle passes without the change (exit ${red.exitCode} on the base commit plus ${testFiles.length} changed test file(s)), so it proves nothing about this task`,
        Buffer.concat([red.stdout, red.stderr]),
      );
    }

    git(path, "read-tree", "-u", "--reset", tree);
    const greenSetup = runSetup(path, oracle.setup);
    if (!greenSetup.ok) {
      return fail(
        "setup",
        greenSetup.exitCode,
        `oracle.setup exited ${greenSetup.exitCode} on the verified tree`,
        Buffer.alloc(0),
      );
    }
    const green: OracleRun[] = [];
    for (let i = 0; i < opts.runs; i += 1) {
      const run = runOracle(path, oracle.run);
      green.push({
        exit_code: run.exitCode,
        duration_ms: run.durationMs,
        stdout_sha256: sha256(run.stdout),
        stderr_sha256: sha256(run.stderr),
      });
      if (run.exitCode !== want) {
        return fail(
          "green",
          run.exitCode,
          `the oracle exited ${run.exitCode} on the verified tree (run ${i + 1} of ${opts.runs}), expected ${want}`,
          Buffer.concat([run.stdout, run.stderr]),
          green,
        );
      }
    }
    return {
      ok: true,
      testFiles,
      red: {
        exit_code: red.exitCode,
        stdout_sha256: sha256(red.stdout),
        stderr_sha256: sha256(red.stderr),
      },
      green,
    };
  } finally {
    try {
      removeScratchWorktree(root, path);
    } catch {
      // swept at the next session start if removal fails here
    }
  }
}
