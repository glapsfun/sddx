// What sddx 5 generated into `.claude/`, frozen for `sddx migrate`. v6 no longer
// generates anything into the repository, so this module only answers two
// questions about a v5 install: which files sddx provably owns, and how to take
// sddx's hook registrations out of `.claude/settings.json` without touching the
// user's own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../receipt";
import table from "./v5-claude-ownership.json";

export const V5_MANIFEST_PATH = ".sddx/local/adapters/claude-install.json";
export const V5_DECLARATION_PATH = ".sddx/adapters/claude.json";
export const V5_SETTINGS_PATH = ".claude/settings.json";

/** path -> every sha256 sddx 5.0.0 could have written there. */
export const V5_OWNED: Readonly<Record<string, readonly string[]>> = table.files;

/** The hashes the local install manifest recorded, when the machine still has one. */
export function readV5Manifest(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(root, V5_MANIFEST_PATH), "utf8")) as {
      files?: unknown;
    };
    const files = raw.files;
    return typeof files === "object" && files !== null && !Array.isArray(files)
      ? (files as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export type Ownership = "owned" | "modified" | "absent";

/** Whether `path` holds exactly what sddx 5 generated there. */
export function v5Ownership(
  root: string,
  path: string,
  manifest: Record<string, string>,
): Ownership {
  const abs = join(root, path);
  if (!existsSync(abs)) return "absent";
  const hash = sha256(readFileSync(abs));
  if (manifest[path] === hash || (V5_OWNED[path] ?? []).includes(hash)) return "owned";
  return "modified";
}

/** The hook events sddx 5 registered: the vocabulary ownership is matched on. */
const HOOK_EVENTS = [
  "session-start",
  "tdd-gate",
  "bash-gate",
  "approval-gate",
  "record-test",
  "stop-gate",
] as const;

/** A hook command sddx generated: an invocation ending in `... hook <known-event>`.
 * Matching the emitted shape, not a substring, keeps user hooks whose paths or
 * messages merely mention sddx out of reach. */
const SDDX_HOOK_COMMAND = new RegExp(
  `(?:^|[\\s"'/])(?:sddx|hooks\\.mjs)["']?\\s+(?:hook\\s+)?(?:${HOOK_EVENTS.join("|")})\\s*$`,
);

interface HookEntry {
  matcher?: string;
  hooks: Array<{ command?: unknown; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** True only when every command in the entry is sddx's; a mixed entry is the user's. */
const isSddxEntry = (entry: HookEntry): boolean =>
  Array.isArray(entry.hooks) &&
  entry.hooks.length > 0 &&
  entry.hooks.every(
    (h) => typeof h?.command === "string" && SDDX_HOOK_COMMAND.test(h.command.trim()),
  );

function detectIndent(source: string): number {
  const m = /\n(\x20+)"/.exec(source);
  return m ? (m[1] as string).length : 2;
}

/** Settings JSON with every sddx hook entry removed and everything else, key
 * order and indentation included, left as it was. Unparseable input is returned
 * unchanged: it is not sddx's to rewrite. */
export function unmergeV5Settings(existing: string): { text: string; removed: number } {
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { text: existing, removed: 0 };
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return { text: existing, removed: 0 };
  }
  let removed = 0;
  const hooks = { ...((doc.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    const theirs = (entries ?? []).filter((e) => !isSddxEntry(e));
    removed += (entries ?? []).length - theirs.length;
    if (theirs.length === 0) delete hooks[event];
    else hooks[event] = theirs;
  }
  if (removed === 0) return { text: existing, removed: 0 };
  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { text: `${JSON.stringify(next, null, detectIndent(existing))}\n`, removed };
}
