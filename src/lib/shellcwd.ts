// A command that starts with `cd <dir> &&` or `cd <dir>;` runs the rest in
// <dir>. A subagent working in a task's worktree writes its commands that way,
// because its shell starts in the session's directory, so the strict hooks
// judge the rest of the command there. Only a plain directory word is read:
// letters, digits and `_ . / - @ % + , :`, not starting with `-` or `+`. Any
// other character can be shell syntax (a redirect, an expansion, a glob), and
// then the command is left as it is, to be judged whole.
import { resolve } from "node:path";

const LEADING_CD = /^\s*cd\s+([\w./][\w./@%+,:-]*)\s*(?:&&|;)\s*/;

export function withLeadingCd(
  command: string,
  cwd: string,
): { command: string; cwd: string; dirs: string[] } {
  let rest = command;
  let dir = cwd;
  // with `;` a failed cd leaves the rest running where it was, so every
  // directory along the way is one the rest may run in
  const dirs = [cwd];
  for (let m = LEADING_CD.exec(rest); m; m = LEADING_CD.exec(rest)) {
    dir = resolve(dir, m[1] as string);
    dirs.push(dir);
    rest = rest.slice(m[0].length);
  }
  return { command: rest, cwd: dir, dirs };
}

/** `word` as one shell word, for a command someone types: as it is when plain, else single-quoted. */
export const shellWord = (word: string): string =>
  /^[\w./@%+,:-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
