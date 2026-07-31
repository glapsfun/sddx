// Optional user-global state at `~/.sddx/`.
//
// The word that governs this whole module is OPTIONAL. Project execution truth
// lives in the repository — specs, tasks, receipts, the run branch. Nothing
// here may change a lifecycle decision, and every read degrades to "absent"
// rather than throwing, because a machine where `$HOME` is unwritable must
// still be able to run a task to a verified receipt.
//
// It is also private. The directory is created owner-only where the platform
// allows it, memory carries the project it belongs to, and nothing is written
// here automatically that a user would be alarmed to find.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git";
import { sha256 } from "./receipt";

/** `~/.sddx`, honoring an explicit override for tests and unusual homes. */
export function globalRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SDDX_HOME ?? join(homedir(), ".sddx");
}

/**
 * Normalizes a remote URL so the same repository hashes identically however it
 * was cloned: scp-style vs. ssh:// vs. https://, with or without `.git`, with
 * or without credentials.
 */
function normalizeRemote(url: string): string {
  let s = url.trim().replace(/\.git$/, "");
  s = s
    .replace(/^ssh:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/^git:\/\//, "");
  s = s.replace(/^[^@/]+@/, ""); // user@ or user:token@
  s = s.replace(":", "/"); // scp-style host:path → host/path
  return s.toLowerCase();
}

/** A filesystem-safe, human-recognizable fragment of the repository's name. */
function slug(source: string): string {
  const name = source.split("/").filter(Boolean).pop() ?? "repo";
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned === "" ? "repo" : cleaned.slice(0, 32);
}

export interface ProjectKey {
  key: string;
  /** Which identity source won — useful in diagnostics, never in decisions. */
  source: "remote" | "first-commit" | "path";
}

/**
 * A stable identity for this repository.
 *
 * Preference order matters. The origin remote is the same across every clone of
 * a project, so two developers' machines agree. The first-commit SHA is the
 * next best thing for a repository with no remote — still identical across
 * clones. The absolute path is the last resort, and the only one that differs
 * between clones, which is why it is last.
 *
 * The hash suffix is not decoration: two unrelated repositories both named
 * `api` must not share a directory, and a slug alone cannot promise that.
 */
export function projectKey(root: string): ProjectKey {
  const attempt = (fn: () => string): string | null => {
    try {
      const v = fn().trim();
      return v === "" ? null : v;
    } catch {
      return null;
    }
  };

  const remote = attempt(() => git(root, "config", "--get", "remote.origin.url"));
  if (remote !== null) {
    const normalized = normalizeRemote(remote);
    return { key: `${slug(normalized)}-${sha256(normalized).slice(0, 12)}`, source: "remote" };
  }

  const firstCommit = attempt(() => {
    const shas = git(root, "rev-list", "--max-parents=0", "HEAD").split("\n");
    return (shas[shas.length - 1] ?? "").trim();
  });
  if (firstCommit !== null) {
    return {
      key: `${slug(root)}-${sha256(firstCommit).slice(0, 12)}`,
      source: "first-commit",
    };
  }

  return { key: `${slug(root)}-${sha256(root).slice(0, 12)}`, source: "path" };
}

export const projectDir = (root: string, env?: NodeJS.ProcessEnv): string =>
  join(globalRoot(env), "projects", projectKey(root).key);

/**
 * Creates a directory owner-only.
 *
 * `chmod` after `mkdir` rather than relying on the mode argument, because the
 * process umask silently subtracts from it — a 0700 request under an unusual
 * umask can land as something laxer, which is exactly the failure this is
 * guarding against.
 */
function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Platforms without POSIX permissions (and odd filesystems) simply do not
    // get this guarantee. Failing here would make global state mandatory.
  }
}

function writePrivate(path: string, contents: string): void {
  mkdirPrivate(dirname(path));
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // as above
  }
}

export interface ProjectMetadata {
  schema_version: string;
  project_key: string;
  key_source: ProjectKey["source"];
  /** Where this project lived when the record was written. Advisory only. */
  last_known_path: string;
}

export const GLOBAL_SCHEMA_VERSION = "1.0";

/**
 * Records that this project exists. Best-effort by contract: a failure to write
 * user-global state is never a reason for a command to fail.
 */
export function rememberProject(root: string, env?: NodeJS.ProcessEnv): ProjectMetadata | null {
  try {
    const { key, source } = projectKey(root);
    const metadata: ProjectMetadata = {
      schema_version: GLOBAL_SCHEMA_VERSION,
      project_key: key,
      key_source: source,
      last_known_path: root,
    };
    writePrivate(
      join(projectDir(root, env), "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    return metadata;
  } catch {
    return null;
  }
}

/**
 * This project's memory, or null.
 *
 * Provenance is enforced on READ, not just written on trust: a memory file
 * whose header names a different project is ignored. Without that check, moving
 * or copying a directory under `~/.sddx/projects/` would quietly feed one
 * project's notes into another's context.
 */
export function readMemory(root: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    const path = join(projectDir(root, env), "memory.md");
    if (!existsSync(path)) return null;
    const contents = readFileSync(path, "utf8");
    const { key } = projectKey(root);
    return contents.includes(provenanceLine(key)) ? contents : null;
  } catch {
    return null;
  }
}

const provenanceLine = (key: string): string => `<!-- sddx-project: ${key} -->`;

/** Writes project memory with its provenance header. Best-effort. */
export function writeMemory(root: string, body: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    const { key } = projectKey(root);
    writePrivate(
      join(projectDir(root, env), "memory.md"),
      `${provenanceLine(key)}\n\n${body.replace(/\s*$/, "")}\n`,
    );
    return true;
  } catch {
    return false;
  }
}
