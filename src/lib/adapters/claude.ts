// The Claude Code project adapter — the first implementation of the adapter
// contract, and the only one that ships.
//
// Everything it writes lands under the repository's own `.claude/` tree. It
// never registers a marketplace plugin and never touches user-global Claude
// configuration: an adapter that reached outside the repository would make
// `sddx uninstall` unable to promise it had cleaned up.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, AdapterContext, GeneratedFile, MergeTarget } from "../adapter";
import { sha256 } from "../receipt";

/**
 * The placeholder every template uses in place of an sddx invocation.
 *
 * One placeholder, substituted once, is the whole point: the templates used to
 * carry 18 references to a plugin-root variable, each of which had to be
 * correct for the integration to work. Now there is a single thing that can be
 * wrong, and the resolver decides it from committed policy.
 */
export const INVOCATION_PLACEHOLDER = "{{SDDX}}";

/**
 * Where the templates live, relative to this module.
 *
 * Resolved through `import.meta.url` so it works from a source checkout
 * (`src/lib/adapters/` → `../../../templates`) and from the published package
 * (`dist/cli.mjs` → `../templates`), which are different depths — hence the
 * candidate list rather than a single path.
 */
function templateRoot(): string {
  const candidates = ["../../../templates/claude", "../templates/claude"];
  for (const rel of candidates) {
    // fileURLToPath, never URL.pathname: pathname is percent-encoded, so a
    // path containing a space (`/Users/jane doe/…`, `C:\Program Files\…`)
    // resolves to a directory that does not exist, and the user is told their
    // package is corrupt.
    const dir = fileURLToPath(new URL(`${rel}/`, import.meta.url));
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "sddx: adapter templates not found. This build is incomplete — reinstall @glapsfun/sddx.",
  );
}

/** Every file under `dir`, as repo-relative POSIX paths plus contents. */
function readTemplateTree(dir: string, prefix = ""): Array<{ rel: string; contents: string }> {
  const out: Array<{ rel: string; contents: string }> = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) out.push(...readTemplateTree(abs, rel));
    else out.push({ rel, contents: readFileSync(abs, "utf8") });
  }
  return out;
}

const substitute = (contents: string, ctx: AdapterContext): string =>
  contents.split(INVOCATION_PLACEHOLDER).join(ctx.invocation);

/**
 * Generated assets are `sddx`-prefixed.
 *
 * Two reasons. A project-local skill named `run` would collide with any skill
 * the user already calls `run` — and silently shadowing a user's own asset is
 * exactly the kind of damage this adapter exists to avoid. It also means
 * ownership is legible from the path alone, so uninstall and collision
 * detection have a cheap first-pass filter that works even with no manifest.
 */
const CLAUDE_DIR = ".claude";

function generatedPath(kind: "skills" | "agents", name: string): string {
  return kind === "skills"
    ? `${CLAUDE_DIR}/skills/sddx-${name}/SKILL.md`
    : `${CLAUDE_DIR}/agents/sddx-${name}.md`;
}

function generate(ctx: AdapterContext): GeneratedFile[] {
  const root = templateRoot();
  const files: GeneratedFile[] = [];

  for (const { rel, contents } of readTemplateTree(join(root, "skills"))) {
    // `<name>/SKILL.md` — the directory name is the skill name.
    const name = rel.split("/")[0] as string;
    files.push({ path: generatedPath("skills", name), contents: substitute(contents, ctx) });
  }

  for (const { rel, contents } of readTemplateTree(join(root, "agents"))) {
    const name = rel.replace(/\.md$/, "");
    files.push({ path: generatedPath("agents", name), contents: substitute(contents, ctx) });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Settings merge
// ---------------------------------------------------------------------------

/** The hook events sddx registers. Also the vocabulary ownership is matched on. */
const HOOK_EVENTS = [
  "session-start",
  "tdd-gate",
  "bash-gate",
  "approval-gate",
  "record-test",
  "stop-gate",
] as const;

/**
 * Recognizes a hook command as one sddx generated.
 *
 * Matching must be precise in BOTH directions, and the failure modes are not
 * symmetric. Too loose and the merge deletes hooks the user wrote — silent,
 * unrecoverable data loss in a committed file. Too tight and a previous
 * generation's entries are stranded in the user's settings with nothing able
 * to remove them.
 *
 * So it matches the shape sddx actually emits — an invocation ending in
 * `… hook <known-event>` — rather than a substring. A bare `"sddx"` test was
 * the original approach and was wrong: it claimed ownership of
 * `/Users/me/dev/sddx-tools/audit.sh` and `notify-send 'sddx run finished'`,
 * and of every user hook in any checkout whose path happens to contain the
 * word. The plugin-era form is matched too, so migrating replaces those
 * registrations instead of duplicating them.
 */
const SDDX_HOOK_COMMAND = new RegExp(
  `(?:^|[\\s"'/])(?:sddx|hooks\\.mjs)["']?\\s+(?:hook\\s+)?(?:${HOOK_EVENTS.join("|")})\\s*$`,
);

const isSddxCommand = (command: unknown): boolean =>
  typeof command === "string" && SDDX_HOOK_COMMAND.test(command.trim());

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

/**
 * True only when EVERY command in the entry is one of ours.
 *
 * An entry mixing an sddx command with a user's own is the user's: dropping it
 * to replace our half would take theirs with it, and there is no safe way to
 * split someone else's grouping.
 */
const isSddxEntry = (entry: HookEntry): boolean =>
  Array.isArray(entry.hooks) &&
  entry.hooks.length > 0 &&
  entry.hooks.every((h) => isSddxCommand(h?.command));

/** The hook registrations sddx contributes, read from the template. */
function templateHooks(ctx: AdapterContext): Record<string, HookEntry[]> {
  const raw = readFileSync(join(templateRoot(), "hooks", "hooks.json"), "utf8");
  const parsed = JSON.parse(substitute(raw, ctx)) as { hooks: Record<string, HookEntry[]> };
  return parsed.hooks;
}

/** Raised when a settings file cannot be merged. Reported as a conflict. */
export class SettingsUnreadableError extends Error {
  constructor(reason: string) {
    super(`${CLAUDE_DIR}/settings.json ${reason} — refusing to overwrite it`);
    this.name = "SettingsUnreadableError";
  }
}

/** The document's existing indentation, so the merge does not restyle it. */
function detectIndent(source: string): number {
  const m = /\n(\x20+)"/.exec(source);
  return m ? (m[1] as string).length : 2;
}

/**
 * Settings JSON with sddx's hook entries present exactly once.
 *
 * Every unrelated key and every non-sddx hook entry survives verbatim, and
 * that is meant literally: the document's key ORDER and indentation are
 * preserved, and only the `hooks` value is rewritten. Key-sorting the whole
 * document (the original approach) produced a whole-file diff attributed to
 * sddx on a committed, team-shared file, which reviewers could not separate
 * from the registration it was supposed to add.
 *
 * Re-running is byte-identical, because our own output is a fixed point: the
 * entries we emit come from the template in a fixed order.
 */
function mergeSettings(existing: string | null, ctx: AdapterContext): string {
  let doc: Record<string, unknown> = {};
  const source = existing ?? "";
  if (source.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (e) {
      throw new SettingsUnreadableError(`is not valid JSON (${(e as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SettingsUnreadableError("is not a JSON object");
    }
    doc = parsed as Record<string, unknown>;
  }

  const hooks = { ...((doc.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  const ours = templateHooks(ctx);

  for (const [event, ourEntries] of Object.entries(ours)) {
    const theirs = (hooks[event] ?? []).filter((e) => !isSddxEntry(e));
    hooks[event] = [...theirs, ...ourEntries];
  }
  // An event we no longer register but previously did: drop our entries, keep
  // theirs, and remove the key entirely if nothing is left.
  for (const [event, entries] of Object.entries(hooks)) {
    if (event in ours) continue;
    const theirs = (entries ?? []).filter((e) => !isSddxEntry(e));
    if (theirs.length === 0) delete hooks[event];
    else hooks[event] = theirs;
  }

  // Spread order preserves the document's existing key order; `hooks` lands in
  // its original position when it was already present, and last when it was not.
  return `${JSON.stringify({ ...doc, hooks }, null, detectIndent(source))}\n`;
}

/** Settings JSON with every sddx hook entry removed, user content untouched. */
function unmergeSettings(existing: string): string {
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Not ours to rewrite. Returning it unchanged leaves the user's file
      // exactly as found, which is the right outcome for an uninstall.
      return existing;
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return existing;
  }
  const hooks = { ...((doc.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    const theirs = (entries ?? []).filter((e) => !isSddxEntry(e));
    if (theirs.length === 0) delete hooks[event];
    else hooks[event] = theirs;
  }
  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return `${JSON.stringify(next, null, detectIndent(existing))}\n`;
}

/**
 * A stable hash over just sddx's entries.
 *
 * Fingerprinting the whole file would make a user's edit to an unrelated key
 * look like tampering with ours, so every sync would refuse for a reason the
 * user could not act on.
 */
function settingsFingerprint(existing: string): string | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hooks = (doc.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  const ourEntries: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const mine = (entries ?? []).filter((e) => isSddxEntry(e));
    if (mine.length > 0) ourEntries[event] = mine;
  }
  if (Object.keys(ourEntries).length === 0) return null;
  return sha256(JSON.stringify(sortKeys(ourEntries)));
}

/** Recursively key-sorted copy, so serialization is order-independent. */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

function mergeTargets(ctx: AdapterContext): MergeTarget[] {
  return [
    {
      // The COMMITTED, team-shared settings file — not settings.local.json.
      // The TDD gate is a team contract: putting it somewhere personal and
      // gitignored would mean a teammate's session silently has no gate, which
      // is the prompt-level-discipline failure sddx exists to eliminate.
      path: `${CLAUDE_DIR}/settings.json`,
      merge: (existing) => mergeSettings(existing, ctx),
      unmerge: unmergeSettings,
      fingerprint: settingsFingerprint,
    },
  ];
}

export const claudeAdapter: Adapter = { name: "claude", generate, mergeTargets };
