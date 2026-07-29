// The Claude Code project adapter — the first implementation of the adapter
// contract, and the only one that ships.
//
// Everything it writes lands under the repository's own `.claude/` tree. It
// never registers a marketplace plugin and never touches user-global Claude
// configuration: an adapter that reached outside the repository would make
// `sddx uninstall` unable to promise it had cleaned up.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
    const dir = new URL(`${rel}/`, import.meta.url).pathname;
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

/**
 * The marker that makes an entry identifiable as sddx's.
 *
 * Without it, sync and uninstall would have to identify their own entries by
 * diffing against freshly generated content — which breaks the moment the
 * generated form changes, stranding the previous generation's entries in the
 * user's settings forever with nothing able to remove them.
 */
const OWNED_MARKER = "sddx";

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

const isSddxEntry = (entry: HookEntry): boolean =>
  Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(OWNED_MARKER));

/** The hook registrations sddx contributes, read from the template. */
function templateHooks(ctx: AdapterContext): Record<string, HookEntry[]> {
  const raw = readFileSync(join(templateRoot(), "hooks", "hooks.json"), "utf8");
  const parsed = JSON.parse(substitute(raw, ctx)) as { hooks: Record<string, HookEntry[]> };
  return parsed.hooks;
}

/**
 * Settings JSON with sddx's hook entries present exactly once.
 *
 * Every unrelated key and every non-sddx hook entry survives verbatim; only
 * entries carrying the marker are replaced. Written with stable key ordering
 * and two-space indentation so re-running produces no diff — a merge that
 * reformatted the file would show up as damage in every review.
 */
function mergeSettings(existing: string | null, ctx: AdapterContext): string {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `${CLAUDE_DIR}/settings.json is not a JSON object — refusing to overwrite it`,
      );
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
    const theirs = entries.filter((e) => !isSddxEntry(e));
    if (theirs.length === 0) delete hooks[event];
    else hooks[event] = theirs;
  }

  return `${JSON.stringify(sortKeys({ ...doc, hooks }), null, 2)}\n`;
}

/** Settings JSON with every sddx hook entry removed, user content untouched. */
function unmergeSettings(existing: string): string {
  const doc = JSON.parse(existing) as Record<string, unknown>;
  const hooks = { ...((doc.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    const theirs = entries.filter((e) => !isSddxEntry(e));
    if (theirs.length === 0) delete hooks[event];
    else hooks[event] = theirs;
  }
  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return `${JSON.stringify(sortKeys(next), null, 2)}\n`;
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
