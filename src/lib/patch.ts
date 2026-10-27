// Codex's apply_patch format, read only for the paths a patch writes. The
// approval gate judges a patch by those paths, the way it judges a file-tool
// write, and never reads patch text as shell.
//
//   *** Begin Patch
//   *** Add File: <path>       *** Delete File: <path>
//   *** Update File: <path>    [*** Move to: <path>]
//   *** End Patch

const TARGET = /^\s*\*\*\*\s*(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;

/** Every path a patch adds, updates, deletes or moves a file to. */
export function patchTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = TARGET.exec(line);
    if (m) out.push(m[1] as string);
  }
  return out;
}

interface Opener {
  strip: boolean;
  delimiter: string;
  /** The heredoc feeds apply_patch: the rest of its line before `<<` is `[cd <dir> && …] apply_patch`. */
  patch: boolean;
}

const OPENER = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
const FEEDS_PATCH = /^\s*(?:cd\s+[^\s;&|]+\s*(?:&&|;)\s*)*apply_patch\s*$/;

/** Heredoc openers outside quotes and comments, carrying quote state across lines. */
function openersIn(line: string, state: { quote: string | null }): Opener[] {
  const out: Opener[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (state.quote !== null) {
      if (c === "\\" && state.quote !== "'") i += 1;
      else if (c === state.quote) state.quote = null;
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state.quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) break;
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = OPENER.exec(line.slice(i));
      if (!m) continue;
      out.push({
        strip: m[1] === "-",
        delimiter: m[3] as string,
        patch: FEEDS_PATCH.test(line.slice(0, i)),
      });
      i += m[0].length - 1;
    }
  }
  return out;
}

/**
 * The bodies of the heredocs a shell command feeds to apply_patch, and the
 * command without them. Every other heredoc body stays in the shell text, so
 * it is judged as before. A body ends at a line holding only its delimiter
 * (tabs stripped for `<<-`); when one never ends, the shell reads to the end
 * of the input, and the whole command stays shell text: judging too much is
 * the safe side.
 */
export function applyPatchHeredocs(command: string): { shell: string; bodies: string[] } {
  const shell: string[] = [];
  const bodies: string[] = [];
  const pending: Opener[] = [];
  const state = { quote: null as string | null };
  let body: string[] = [];
  for (const line of command.split("\n")) {
    const open = pending[0];
    if (open) {
      const ends = (open.strip ? line.replace(/^\t+/, "") : line) === open.delimiter;
      if (open.patch) {
        if (ends) bodies.push(body.join("\n"));
        else body.push(line);
      } else {
        shell.push(line);
      }
      if (ends) {
        pending.shift();
        body = [];
      }
      continue;
    }
    shell.push(line);
    pending.push(...openersIn(line, state));
  }
  if (pending.length > 0) {
    return { shell: command, bodies: pending[0]?.patch ? [...bodies, body.join("\n")] : bodies };
  }
  return { shell: shell.join("\n"), bodies };
}
