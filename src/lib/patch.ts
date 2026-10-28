// Codex's apply_patch format, read only for the paths a patch writes. The
// approval gate judges a patch by those paths, the way it judges a file-tool
// write, and never reads patch text as shell.
//
//   *** Begin Patch
//   *** Add File: <path>       *** Delete File: <path>
//   *** Update File: <path>    [*** Move to: <path>]
//   *** End Patch
//
// Codex trims a line before reading it as a header. Inside an Update File hunk,
// though, only a line that starts with `***` ends the hunk, so a context line
// such as ` *** Add File: x` is file content there, not a header.
import { withLeadingCd } from "./shellcwd";

const HEADER = /^\*\*\*\s*(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/i;
const OPENS_UPDATE = /^\*\*\*\s*(?:Update File|Move to):/i;

/** Every path a patch adds, updates, deletes or moves a file to. */
export function patchTargets(text: string): string[] {
  const out: string[] = [];
  let update = false;
  for (const line of text.split(/\r?\n/)) {
    if (update && (!line.startsWith("***") || line.trim() === "*** End of File")) continue;
    const m = HEADER.exec(line.trim());
    update = m !== null && OPENS_UPDATE.test(line.trim());
    if (m) out.push(m[1] as string);
  }
  return out;
}

const OPENER = /^\s*apply_patch\s*<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*$/;

/**
 * A shell command whose first line is `[cd <dir> && …] apply_patch <<'EOF'`,
 * with a quoted delimiter and nothing after it, split into the patch, the
 * directories it may be applied in, and the shell text around it. Anything
 * else is null, and the whole command is judged as shell: an unquoted
 * delimiter expands `$(…)` in the body, a trailing `\` carries the command
 * into the next line, a heredoc on a later line runs wherever the lines before
 * it left the shell, and a body that never ends runs to the end of the input.
 */
export function leadingPatchHeredoc(
  command: string,
  cwd: string,
): { patch: string; dirs: string[]; shell: string } | null {
  const lines = command.split("\n");
  const first = lines[0] as string;
  const { command: rest, dirs } = withLeadingCd(first, cwd);
  const m = OPENER.exec(rest);
  if (!m) return null;
  const body = (line: string) => (m[1] === "-" ? line.replace(/^\t+/, "") : line);
  const end = lines.findIndex((line, i) => i > 0 && body(line) === m[3]);
  if (end === -1) return null;
  return {
    patch: lines.slice(1, end).map(body).join("\n"),
    dirs,
    shell: [first, ...lines.slice(end + 1)].join("\n"),
  };
}
