// A command that starts with `cd <dir> &&` or `cd <dir>;` runs the rest in
// <dir>. A subagent working in a task's worktree writes its commands that way,
// because its shell starts in the session's directory, so the strict hooks
// judge the rest of the command there. Only a plain directory word is read:
// one that is quoted, escaped or expanded leaves the command as it is.
import { resolve } from "node:path";

const LEADING_CD = /^\s*cd\s+([^\s"'`$\\;&|~]+)\s*(?:&&|;)\s*/;

export function withLeadingCd(command: string, cwd: string): { command: string; cwd: string } {
  let rest = command;
  let dir = cwd;
  for (let m = LEADING_CD.exec(rest); m; m = LEADING_CD.exec(rest)) {
    dir = resolve(dir, m[1] as string);
    rest = rest.slice(m[0].length);
  }
  return { command: rest, cwd: dir };
}
