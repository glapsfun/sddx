// `sddx init` — the bootstrap boundary.
//
// The shape here is plan-then-apply, and the split is load-bearing rather than
// stylistic: `init` mutates a repository the user already cares about, so every
// file it would touch, every package-manager command it would run, and every
// config value it would write is computed and shown BEFORE anything happens.
// A user who declines, or a `--dry-run`, must leave the tree byte-identical.
//
// Nothing in this module prompts. The interactive initializer collects choices
// and hands them here; the flag path builds the same object. One core, two
// clients — an interactive-only code path would be a second implementation of
// the thing that mutates the user's repository.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_SCHEMA_VERSION,
  type InteractionMode,
  type PackageManager,
  type RuntimeScope,
} from "./config";

/** The choices `init` needs. Identical whether a prompt or a flag produced them. */
export interface InitOptions {
  runtimeScope: RuntimeScope;
  packageManager: PackageManager;
  adapters: string[];
  interactionMode: InteractionMode;
}

export type FileOpKind = "create" | "modify" | "unchanged";

export interface FileOp {
  /** Repo-relative, POSIX-separated — the path a user would recognize. */
  path: string;
  kind: FileOpKind;
  /** Full intended contents. Absent for `unchanged`. */
  contents?: string;
  /** Why this file is in the plan, shown in the preview. */
  reason: string;
}

export interface PackageOp {
  /** Argv, not a shell string: nothing here goes through a shell. */
  command: string[];
  reason: string;
}

export interface InitPlan {
  /** Absolute repository root every path resolves against. */
  root: string;
  files: FileOp[];
  packageOps: PackageOp[];
  /** The exact object that will be written to `.sddx/config.json`. */
  config: Record<string, unknown>;
}

/** A plan with nothing left to do — what a correct second `init` produces. */
export function planIsNoop(plan: InitPlan): boolean {
  return plan.files.every((f) => f.kind === "unchanged") && plan.packageOps.length === 0;
}

export class NotAGitRepositoryError extends Error {
  constructor(readonly cwd: string) {
    super(
      `not a git repository: ${cwd}\n` +
        "sddx init operates on a repository — its state lives in git, and a worktree per task is the isolation model.\n" +
        "Run `git init` first, or run sddx init from inside an existing repository.",
    );
    this.name = "NotAGitRepositoryError";
  }
}

/**
 * The repository root enclosing `cwd`, resolved through git itself.
 *
 * `git rev-parse --show-toplevel` rather than walking for `.git`, because it
 * gets the cases a hand-rolled walk gets wrong: a worktree's `.git` file, a
 * `GIT_DIR` in the environment, and symlinked paths all resolve correctly.
 */
export function repositoryRoot(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new NotAGitRepositoryError(cwd);
  const root = (r.stdout ?? "").trim();
  if (root === "") throw new NotAGitRepositoryError(cwd);
  return root;
}

/** Tracked `.sddx/` subdirectories — committed, because they are the audit trail. */
const TRACKED_SDDX_DIRS = [
  "specs",
  "drafts",
  "context",
  "tasks",
  "goals",
  "receipts",
  "adapters",
] as const;

/**
 * Ephemeral paths, and the complete list of what `init` adds to `.gitignore`.
 *
 * `.sddx/` as a whole is deliberately NOT ignored: specs, tasks, goals, and
 * receipts are the tamper-evident record, and a record that is not committed
 * did not happen.
 */
export const EPHEMERAL_PATHS = [
  ".sddx/local/",
  ".sddx/cache/",
  ".sddx/sessions/",
  ".sddx-worktrees/",
] as const;

const GITIGNORE_BEGIN = "# sddx (generated) — do not edit between markers";
const GITIGNORE_END = "# end sddx";

/** The generated block, exactly as it is written. */
export function gitignoreBlock(): string {
  return [GITIGNORE_BEGIN, ...EPHEMERAL_PATHS, GITIGNORE_END].join("\n");
}

/**
 * `.gitignore` with the sddx block present exactly once.
 *
 * Keyed on the markers rather than on the individual entries, so a user who
 * adds their own `.sddx/cache/` line elsewhere keeps it, and a re-run replaces
 * the block wholesale instead of appending near-duplicates. Everything outside
 * the markers is preserved verbatim: line order, comments, and trailing
 * whitespace are all the user's, not ours to normalize.
 */
export function withGitignoreBlock(existing: string): string {
  const block = gitignoreBlock();
  const begin = existing.indexOf(GITIGNORE_BEGIN);
  if (begin !== -1) {
    const endMarker = existing.indexOf(GITIGNORE_END, begin);
    if (endMarker !== -1) {
      const end = endMarker + GITIGNORE_END.length;
      return existing.slice(0, begin) + block + existing.slice(end);
    }
    // A begin marker with no end: the block was hand-edited into something we
    // cannot delimit. Replacing from the marker to end-of-file could eat the
    // user's rules, so append a fresh block and leave the damaged one alone
    // for a human to remove.
  }
  const needsNewline = existing !== "" && !existing.endsWith("\n");
  const separator = existing === "" ? "" : needsNewline ? "\n\n" : "\n";
  return `${existing}${separator}${block}\n`;
}

/** The config object `init` writes, in a stable key order. */
export function configContents(opts: InitOptions): Record<string, unknown> {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    interaction_mode: opts.interactionMode,
    runtime_scope: opts.runtimeScope,
    package_manager: opts.packageManager,
    adapters: [...opts.adapters].sort(),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Reads a file, or null when it is absent or unreadable. */
function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function fileOp(root: string, relPath: string, contents: string, reason: string): FileOp {
  const current = readIfPresent(join(root, relPath));
  if (current === contents) return { path: relPath, kind: "unchanged", reason };
  return { path: relPath, kind: current === null ? "create" : "modify", contents, reason };
}

/** The install command for a project-pinned runtime, per package manager. */
export function pinInstallCommand(pm: PackageManager): string[] {
  return pm === "bun"
    ? ["bun", "add", "--dev", "@glapsfun/sddx"]
    : ["npm", "install", "--save-dev", "@glapsfun/sddx"];
}

/** Is `@glapsfun/sddx` already a dependency of this project? */
function alreadyPinned(root: string): boolean {
  const pkg = readIfPresent(join(root, "package.json"));
  if (pkg === null) return false;
  try {
    const parsed = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
    return (
      parsed.dependencies?.["@glapsfun/sddx"] !== undefined ||
      parsed.devDependencies?.["@glapsfun/sddx"] !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Computes the full change plan. Pure with respect to the repository: it reads
 * to decide what would change, and writes nothing.
 *
 * `adapterFiles` is injected rather than imported so this module stays free of
 * adapter specifics. It is not optional in spirit: a preview that omitted the
 * files an adapter would write would be a preview the user could not trust,
 * which is worse than showing none at all.
 */
export function planInit(
  cwd: string,
  opts: InitOptions,
  adapterFiles?: (root: string, opts: InitOptions) => FileOp[],
): InitPlan {
  const root = repositoryRoot(cwd);
  const files: FileOp[] = [];

  // Tracked scaffolding. `.gitkeep` because git does not track empty
  // directories, and the layout is part of the contract — a fresh clone should
  // show where things go before anything has been created.
  for (const dir of TRACKED_SDDX_DIRS) {
    files.push(
      fileOp(root, `.sddx/${dir}/.gitkeep`, "", `scaffold the tracked .sddx/${dir}/ directory`),
    );
  }

  const config = configContents(opts);
  files.push(fileOp(root, ".sddx/config.json", json(config), "project policy"));

  const gitignore = readIfPresent(join(root, ".gitignore")) ?? "";
  files.push(
    fileOp(
      root,
      ".gitignore",
      withGitignoreBlock(gitignore),
      "ignore only the ephemeral sddx paths",
    ),
  );

  if (adapterFiles) files.push(...adapterFiles(root, opts));

  const packageOps: PackageOp[] = [];
  if (opts.runtimeScope === "project" && !alreadyPinned(root)) {
    packageOps.push({
      command: pinInstallCommand(opts.packageManager),
      reason: "pin @glapsfun/sddx as a project dependency (project-pinned runtime scope)",
    });
  }

  return { root, files, packageOps, config };
}

/**
 * Undo log for a partially applied plan.
 *
 * Replayed in reverse so a directory is removed after the files inside it.
 * Every step is best-effort and independently attempted: a rollback that threw
 * on the first stubborn artifact would abandon the rest while claiming to have
 * cleaned up, which is worse than the partial state it was fixing.
 */
class InitRollback {
  private steps: Array<{ describe: string; undo: () => void }> = [];

  createdFile(absPath: string, rel: string): void {
    this.steps.push({
      describe: `remove ${rel}`,
      undo: () => {
        if (existsSync(absPath)) rmSync(absPath, { force: true });
      },
    });
  }

  modifiedFile(absPath: string, rel: string, previous: string): void {
    this.steps.push({
      describe: `restore ${rel}`,
      undo: () => writeFileSync(absPath, previous),
    });
  }

  createdDir(absPath: string, rel: string): void {
    this.steps.push({
      describe: `remove ${rel}/`,
      undo: () => {
        if (existsSync(absPath)) rmSync(absPath, { recursive: true, force: true });
      },
    });
  }

  replay(): string[] {
    const undone: string[] = [];
    for (const step of [...this.steps].reverse()) {
      try {
        step.undo();
        undone.push(step.describe);
      } catch (e) {
        undone.push(`${step.describe} — FAILED: ${(e as Error).message}`);
      }
    }
    return undone;
  }
}

export interface ApplyResult {
  /** Repo-relative paths actually written (`unchanged` entries are excluded). */
  written: string[];
  packageOps: string[];
  /** Populated only when the apply failed and was rolled back. */
  rolledBack?: string[];
}

export class InitApplyError extends Error {
  constructor(
    message: string,
    readonly rolledBack: string[],
  ) {
    super(message);
    this.name = "InitApplyError";
  }
}

/**
 * Applies a plan in the one order that is safe.
 *
 * Scaffolding → config → `.gitignore` → adapters → package manager. The
 * package-manager step is last because it is the only one that reaches the
 * network and churns a lockfile: everything cheap and local must have already
 * succeeded before the user's dependency tree is touched.
 *
 * `runAdapters` is injected so this module stays free of adapter specifics; it
 * runs after the local files and before any package operation.
 */
export function applyInit(
  plan: InitPlan,
  opts: { runAdapters?: (plan: InitPlan) => string[]; runCommand?: (cmd: string[]) => void } = {},
): ApplyResult {
  const rollback = new InitRollback();
  const written: string[] = [];
  const packageOps: string[] = [];

  const fail = (message: string): never => {
    throw new InitApplyError(message, rollback.replay());
  };

  try {
    for (const op of plan.files) {
      if (op.kind === "unchanged" || op.contents === undefined) continue;
      const abs = join(plan.root, op.path);
      const dir = dirname(abs);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        rollback.createdDir(dir, op.path.split("/").slice(0, -1).join("/"));
      }
      if (op.kind === "modify") {
        rollback.modifiedFile(abs, op.path, readFileSync(abs, "utf8"));
      } else {
        rollback.createdFile(abs, op.path);
      }
      writeFileSync(abs, op.contents);
      written.push(op.path);
    }
  } catch (e) {
    return fail(`writing project files failed: ${(e as Error).message}`);
  }

  if (opts.runAdapters) {
    try {
      written.push(...opts.runAdapters(plan));
    } catch (e) {
      return fail(`adapter installation failed: ${(e as Error).message}`);
    }
  }

  for (const op of plan.packageOps) {
    const printable = op.command.join(" ");
    try {
      if (opts.runCommand) {
        opts.runCommand(op.command);
      } else {
        const [bin, ...args] = op.command;
        const r = spawnSync(bin as string, args, { cwd: plan.root, encoding: "utf8" });
        if (r.status !== 0) {
          throw new Error((r.stderr ?? "").trim() || `exited ${r.status}`);
        }
      }
      packageOps.push(printable);
    } catch (e) {
      // The package manager is last precisely so this failure is recoverable:
      // roll the local files back and report the command that failed.
      return fail(`\`${printable}\` failed: ${(e as Error).message}`);
    }
  }

  return { written, packageOps };
}
