// The project-adapter contract: how sddx installs, updates, and removes
// integration for an AI harness without ever damaging what the user wrote.
//
// Two ideas carry the whole design.
//
// 1. Generation is a PURE function of committed policy. The same declaration
//    plus the same `.sddx/config.json` produce the same bytes on every machine,
//    which is what makes the generated tree safe to commit and review.
//
// 2. sddx only ever touches what it can PROVE it owns. Ownership is proven by
//    content hash — against the local manifest, or (when that is absent)
//    against what generation says the file should contain. Anything else is a
//    collision, and a collision refuses rather than guessing.
//
// Nothing here names a harness. Claude is one implementation of `Adapter`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PackageManager, RuntimeScope } from "./config";
import { sha256 } from "./receipt";

export const ADAPTER_SCHEMA_VERSION = "1.0";

/** Committed policy: what is installed. Never machine-specific. */
export interface AdapterDeclaration {
  schema_version: string;
  adapter: string;
  [key: string]: unknown;
}

/** One whole file sddx generates and owns end to end. */
export interface GeneratedFile {
  /** Repo-relative, POSIX-separated. */
  path: string;
  contents: string;
}

/**
 * A file sddx contributes *part* of, sharing it with the user.
 *
 * Ownership is tracked over the sddx-owned region only (`fingerprint`), not the
 * whole file — otherwise a user editing an unrelated key would look like
 * tampering and every sync would refuse.
 */
export interface MergeTarget {
  path: string;
  /** The file with sddx's contribution present. Must be idempotent. */
  merge: (existing: string | null) => string;
  /** The file with sddx's contribution removed, user content intact. */
  unmerge: (existing: string) => string;
  /**
   * A stable hash of just the sddx-owned region, or null when the file holds
   * no recognizable sddx contribution.
   */
  fingerprint: (existing: string) => string | null;
}

/** Everything generation is allowed to depend on. Note the absence of anything
 * machine-specific: no PATH, no cwd, no hostname, no timestamps. */
export interface AdapterContext {
  runtimeScope: RuntimeScope;
  packageManager: PackageManager;
  /** The sddx invocation generated content must use. */
  invocation: string;
  sddxVersion: string;
}

export interface Adapter {
  name: string;
  /** Pure: same context in, same bytes out. */
  generate: (ctx: AdapterContext) => GeneratedFile[];
  /** Pure, and each target's merge must be idempotent. */
  mergeTargets: (ctx: AdapterContext) => MergeTarget[];
}

/** Ignored, machine-local record of what this install actually wrote. */
export interface OwnershipManifest {
  schema_version: string;
  adapter: string;
  /** The sddx version that generated the recorded content. */
  sddx_version: string;
  /** The invocation embedded in that content. */
  invocation: string;
  /** path → sha256 of the whole generated file. */
  files: Record<string, string>;
  /** path → sha256 of the sddx-owned region within a shared file. */
  merged: Record<string, string>;
}

export const manifestPath = (adapter: string): string =>
  `.sddx/local/adapters/${adapter}-install.json`;

export const declarationPath = (adapter: string): string => `.sddx/adapters/${adapter}.json`;

function readIfPresent(abs: string): string | null {
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The manifest, normalized so callers can index `files`/`merged` freely.
 *
 * A manifest is ignored, machine-local state: a truncated write, a hand edit,
 * or a version that recorded a different shape are all reachable. Trusting it
 * to be well-formed crashed every command that reads it — including the two a
 * user reaches for precisely when it is damaged, `doctor` and `uninstall`.
 * A malformed manifest degrades to "no ownership recorded", which the
 * generation-matching fallback already handles.
 */
export function readManifest(root: string, adapter: string): OwnershipManifest | null {
  const raw = readIfPresent(join(root, manifestPath(adapter)));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const m = parsed as Partial<OwnershipManifest>;
    const record = (v: unknown): Record<string, string> =>
      typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {};
    return {
      schema_version: typeof m.schema_version === "string" ? m.schema_version : "",
      adapter: typeof m.adapter === "string" ? m.adapter : adapter,
      sddx_version: typeof m.sddx_version === "string" ? m.sddx_version : "",
      invocation: typeof m.invocation === "string" ? m.invocation : "",
      files: record(m.files),
      merged: record(m.merged),
    };
  } catch {
    return null;
  }
}

const hash = (s: string): string => sha256(s);

/** What sddx may do with a destination, and why. */
export type Disposition =
  | { kind: "create"; path: string; contents: string }
  | { kind: "update"; path: string; contents: string }
  | { kind: "unchanged"; path: string }
  /** Recorded by a previous version, no longer generated — prune it. */
  | { kind: "remove"; path: string }
  | { kind: "conflict"; path: string; reason: string };

export interface AdapterPlan {
  adapter: string;
  dispositions: Disposition[];
  /** Set when any disposition is a conflict — the plan must not be applied. */
  conflicts: Array<{ path: string; reason: string }>;
}

export const planHasConflicts = (plan: AdapterPlan): boolean => plan.conflicts.length > 0;

/**
 * Decides what may happen to one whole generated file.
 *
 * The manifest is the primary ownership proof. When it is absent — a teammate
 * who cloned the repo but never installed, an ignored directory that got wiped —
 * matching the expected generated content is accepted as proof instead, because
 * content sddx would itself produce cannot be content sddx must not touch.
 * That is what keeps a missing manifest a recoverable state rather than a
 * broken one.
 */
function disposeFile(
  root: string,
  file: GeneratedFile,
  manifest: OwnershipManifest | null,
): Disposition {
  const current = readIfPresent(join(root, file.path));
  if (current === null) return { kind: "create", path: file.path, contents: file.contents };
  if (current === file.contents) return { kind: "unchanged", path: file.path };

  const recorded = manifest?.files[file.path];
  if (recorded !== undefined && recorded === hash(current)) {
    // Ours, and stale — exactly what sync exists to update.
    return { kind: "update", path: file.path, contents: file.contents };
  }
  return {
    kind: "conflict",
    path: file.path,
    reason:
      recorded === undefined
        ? "a file sddx does not own already exists here"
        : "this file was modified after sddx generated it",
  };
}

function disposeMerge(
  root: string,
  target: MergeTarget,
  manifest: OwnershipManifest | null,
): Disposition {
  const current = readIfPresent(join(root, target.path));
  let merged: string;
  try {
    merged = target.merge(current);
  } catch (e) {
    // An unmergeable file is a CONFLICT, not a crash. Letting this throw took
    // out `sddx doctor` — documented as read-only and degrading to a
    // reportable state — with a bare parse error and no checks at all, which
    // is the worst possible behavior for the command a user runs when their
    // setup is already broken.
    return { kind: "conflict", path: target.path, reason: (e as Error).message };
  }
  if (current === null) return { kind: "create", path: target.path, contents: merged };
  if (current === merged) return { kind: "unchanged", path: target.path };

  const present = target.fingerprint(current);
  if (present === null) {
    // No sddx contribution yet: the rest of the file is the user's and the
    // merge preserves it, so contributing is safe.
    return { kind: "update", path: target.path, contents: merged };
  }
  const recorded = manifest?.merged[target.path];
  if (recorded === undefined || recorded === present) {
    return { kind: "update", path: target.path, contents: merged };
  }
  return {
    kind: "conflict",
    path: target.path,
    reason: "sddx's entries in this file were modified after they were generated",
  };
}

/**
 * Files a previous version generated that this one no longer does.
 *
 * Without this, retiring a generated asset stranded it forever: sync reported
 * "already up to date", doctor reported the adapter healthy, and uninstall
 * reported success — all while the harness kept loading a file the release had
 * deliberately removed. Only paths whose content still matches what the
 * manifest recorded are pruned; anything the user has since edited is theirs.
 */
function disposeRetired(
  root: string,
  adapter: Adapter,
  ctx: AdapterContext,
  manifest: OwnershipManifest | null,
): Disposition[] {
  if (manifest === null) return [];
  const current = new Set(adapter.generate(ctx).map((f) => f.path));
  const out: Disposition[] = [];
  for (const [path, recordedHash] of Object.entries(manifest.files)) {
    if (current.has(path)) continue;
    const onDisk = readIfPresent(join(root, path));
    if (onDisk === null) continue;
    if (hash(onDisk) !== recordedHash) {
      out.push({
        kind: "conflict",
        path,
        reason: "sddx no longer generates this file, and it was modified after sddx wrote it",
      });
      continue;
    }
    out.push({ kind: "remove", path });
  }
  return out;
}

export function planAdapter(root: string, adapter: Adapter, ctx: AdapterContext): AdapterPlan {
  const manifest = readManifest(root, adapter.name);
  const dispositions: Disposition[] = [
    ...adapter.generate(ctx).map((f) => disposeFile(root, f, manifest)),
    ...adapter.mergeTargets(ctx).map((t) => disposeMerge(root, t, manifest)),
    ...disposeRetired(root, adapter, ctx, manifest),
  ];
  const conflicts = dispositions
    .filter((d): d is Extract<Disposition, { kind: "conflict" }> => d.kind === "conflict")
    .map(({ path, reason }) => ({ path, reason }));
  return { adapter: adapter.name, dispositions, conflicts };
}

export class AdapterConflictError extends Error {
  constructor(readonly conflicts: Array<{ path: string; reason: string }>) {
    super(
      [
        `refusing to write ${conflicts.length} file(s) sddx cannot prove it owns:`,
        ...conflicts.map((c) => `  ${c.path} — ${c.reason}`),
        "",
        "Nothing was written. Resolve each one and re-run:",
        "  - keep your version: move it aside, then re-run to regenerate",
        "  - discard your version: re-run with --force to overwrite (a .bak backup is kept)",
      ].join("\n"),
    );
    this.name = "AdapterConflictError";
  }
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function writeFile(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * Applies a plan and records ownership.
 *
 * `force` is the explicit-approval path: it backs a conflicting file up before
 * overwriting, never silently. Without it, a single conflict aborts the whole
 * apply — partial adapter installs are worse than none, because the user is
 * left with a half-wired harness that looks installed.
 */
export function applyAdapter(
  root: string,
  adapter: Adapter,
  ctx: AdapterContext,
  opts: { force?: boolean } = {},
): { written: string[]; backedUp: string[]; removed: string[] } {
  const plan = planAdapter(root, adapter, ctx);
  if (planHasConflicts(plan) && !opts.force) throw new AdapterConflictError(plan.conflicts);

  const written: string[] = [];
  const backedUp: string[] = [];
  const removed: string[] = [];
  const files = adapter.generate(ctx);
  const targets = adapter.mergeTargets(ctx);
  const byPath = new Map(plan.dispositions.map((d) => [d.path, d]));

  for (const file of files) {
    const d = byPath.get(file.path);
    if (d?.kind === "unchanged") continue;
    if (d?.kind === "conflict") {
      const abs = join(root, file.path);
      writeFile(root, `${file.path}.bak`, readFileSync(abs, "utf8"));
      backedUp.push(`${file.path}.bak`);
    }
    writeFile(root, file.path, file.contents);
    written.push(file.path);
  }

  for (const target of targets) {
    const d = byPath.get(target.path);
    if (d?.kind === "unchanged") continue;
    const abs = join(root, target.path);
    const current = readIfPresent(abs);
    const conflicting = d?.kind === "conflict";
    if (conflicting && current !== null) {
      writeFile(root, `${target.path}.bak`, current);
      backedUp.push(`${target.path}.bak`);
    }
    // A forced apply over an UNMERGEABLE file starts from scratch: the backup
    // above holds the original, and merging into content that could not be
    // parsed is not something to attempt twice.
    let contents: string;
    try {
      contents = target.merge(current);
    } catch {
      if (!conflicting)
        throw new AdapterConflictError([{ path: target.path, reason: "unmergeable" }]);
      contents = target.merge(null);
    }
    writeFile(root, target.path, contents);
    written.push(target.path);
  }

  // Prune what a previous version generated and this one does not.
  for (const d of plan.dispositions) {
    if (d.kind !== "remove") continue;
    rmSync(join(root, d.path), { force: true });
    removed.push(d.path);
  }

  writeManifest(root, adapter, ctx);
  return { written, backedUp, removed };
}

export function writeManifest(root: string, adapter: Adapter, ctx: AdapterContext): void {
  const files: Record<string, string> = {};
  for (const f of adapter.generate(ctx)) files[f.path] = hash(f.contents);

  const merged: Record<string, string> = {};
  for (const t of adapter.mergeTargets(ctx)) {
    const current = readIfPresent(join(root, t.path));
    const fp = current === null ? null : t.fingerprint(current);
    if (fp !== null) merged[t.path] = fp;
  }

  const manifest: OwnershipManifest = {
    schema_version: ADAPTER_SCHEMA_VERSION,
    adapter: adapter.name,
    sddx_version: ctx.sddxVersion,
    invocation: ctx.invocation,
    files,
    merged,
  };
  writeFile(root, manifestPath(adapter.name), json(manifest));
}

export function writeDeclaration(root: string, adapter: string, policy: AdapterDeclaration): void {
  writeFile(root, declarationPath(adapter), json(policy));
}

export interface UninstallResult {
  removed: string[];
  /** Owned paths left in place because they no longer match what sddx wrote. */
  keptModified: string[];
}

/**
 * Removes only what the manifest proves sddx owns.
 *
 * A locally modified owned file is reported and LEFT: the user changed it after
 * sddx wrote it, so it is now partly theirs, and deleting it would destroy work
 * on the strength of a stale record.
 */
export function uninstallAdapter(
  root: string,
  adapter: Adapter,
  ctx: AdapterContext,
): UninstallResult {
  const manifest = readManifest(root, adapter.name);
  const removed: string[] = [];
  const keptModified: string[] = [];

  const expected = new Map(adapter.generate(ctx).map((f) => [f.path, hash(f.contents)]));

  // Every path sddx ever wrote, not just the ones it would write today. An
  // uninstall driven only by the current generate() leaves assets from an
  // older version behind while reporting success.
  const owned = new Set([...expected.keys(), ...Object.keys(manifest?.files ?? {})]);

  for (const path of owned) {
    const abs = join(root, path);
    const current = readIfPresent(abs);
    if (current === null) continue;
    const recorded = manifest?.files[path] ?? expected.get(path);
    if (recorded !== hash(current)) {
      keptModified.push(path);
      continue;
    }
    rmSync(abs, { force: true });
    removed.push(path);
  }

  for (const target of adapter.mergeTargets(ctx)) {
    const abs = join(root, target.path);
    const current = readIfPresent(abs);
    if (current === null) continue;
    const present = target.fingerprint(current);
    if (present === null) continue; // nothing of ours is in there
    const recorded = manifest?.merged[target.path];
    if (recorded !== undefined && recorded !== present) {
      keptModified.push(target.path);
      continue;
    }
    // Unmerge rather than delete: the rest of this file is the user's.
    writeFileSync(abs, target.unmerge(current));
    removed.push(`${target.path} (sddx entries)`);
  }

  const manifestAbs = join(root, manifestPath(adapter.name));
  if (existsSync(manifestAbs)) {
    rmSync(manifestAbs, { force: true });
    removed.push(manifestPath(adapter.name));
  }
  const declAbs = join(root, declarationPath(adapter.name));
  if (existsSync(declAbs)) {
    rmSync(declAbs, { force: true });
    removed.push(declarationPath(adapter.name));
  }

  return { removed, keptModified };
}
