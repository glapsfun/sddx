// Runs hooks/run-hook the way Claude Code does, on a PATH the test controls:
// a fake bun that logs each call, the real bun, or no bun at all. HOME is a
// fresh directory so the launcher's ~/.bun fallback cannot find the real one.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./helpers";

export const LAUNCHER = join(repoRoot, "hooks", "run-hook");

export type BunMode = "real" | "none" | { stdout?: string; exit?: number };

export interface LauncherResult {
  status: number | null;
  raw: string;
  stderr: string;
  out: Record<string, unknown>;
  /** One entry per time bun was started, holding its arguments. */
  bunCalls: string[];
  /** What the fake bun received on stdin, per call. */
  bunStdin: string[];
}

export interface LauncherOptions {
  cwd: string;
  bun: BunMode;
  /** Defaults to hooks/run-hook; the helper's own tests point it elsewhere. */
  script?: string;
  env?: Record<string, string>;
}

const FAKE_BUN = `#!/bin/sh
n=$(($(cat "$FAKE_BUN_DIR/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$FAKE_BUN_DIR/count"
printf '%s\\n' "$*" > "$FAKE_BUN_DIR/args.$n"
cat > "$FAKE_BUN_DIR/stdin.$n"
[ -f "$FAKE_BUN_DIR/stdout" ] && cat "$FAKE_BUN_DIR/stdout"
exit "$(cat "$FAKE_BUN_DIR/exit" 2>/dev/null || echo 0)"
`;

/** The external tools the launcher and the fake bun use; nothing else is put on PATH. */
export const LAUNCHER_TOOLS = ["cat", "tr", "sed", "grep"];

/** A directory holding links to just these tools, so a PATH built from it has no bun
 * even on a machine where bun is installed system-wide. */
export function toolDir(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tools-"));
  for (const name of names) {
    const found = Bun.which(name, { PATH: "/usr/bin:/bin" });
    if (!found) throw new Error(`${name} not found in /usr/bin or /bin`);
    symlinkSync(found, join(dir, name));
  }
  return dir;
}

const TOOLS = toolDir(LAUNCHER_TOOLS);

export function runLauncher(
  handler: string,
  payload: Record<string, unknown> | string,
  opts: LauncherOptions,
): LauncherResult {
  const base = mkdtempSync(join(tmpdir(), "launcher-"));
  const bin = join(base, "bin");
  const fake = join(base, "fake");
  const home = join(base, "home");
  for (const d of [bin, fake, home]) mkdirSync(d);
  if (opts.bun === "real") {
    const real = Bun.which("bun");
    if (!real) throw new Error("bun not found on PATH");
    symlinkSync(real, join(bin, "bun"));
  } else if (opts.bun !== "none") {
    writeFileSync(join(bin, "bun"), FAKE_BUN);
    chmodSync(join(bin, "bun"), 0o755);
    if (opts.bun.stdout !== undefined) writeFileSync(join(fake, "stdout"), opts.bun.stdout);
    writeFileSync(join(fake, "exit"), String(opts.bun.exit ?? 0));
  }
  const r = spawnSync(opts.script ?? LAUNCHER, [handler], {
    cwd: opts.cwd,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: {
      PATH: `${bin}:${TOOLS}`,
      HOME: home,
      FAKE_BUN_DIR: fake,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      ...opts.env,
    },
  });
  if (r.error || r.status === null) {
    throw new Error(`launcher did not run: ${r.error?.message ?? `signal ${r.signal}`}`);
  }
  const count = existsSync(join(fake, "count"))
    ? Number(readFileSync(join(fake, "count"), "utf8"))
    : 0;
  const calls = Array.from({ length: count }, (_, i) => i + 1);
  const bunCalls = calls.map((n) => readFileSync(join(fake, `args.${n}`), "utf8").trim());
  const bunStdin = calls.map((n) => readFileSync(join(fake, `stdin.${n}`), "utf8"));
  rmSync(base, { recursive: true, force: true });
  let out: Record<string, unknown> = {};
  try {
    out = r.stdout.trim() === "" ? {} : (JSON.parse(r.stdout) as Record<string, unknown>);
  } catch {
    out = { unparsed: r.stdout };
  }
  return {
    status: r.status,
    raw: r.stdout,
    stderr: r.stderr,
    out,
    bunCalls,
    bunStdin,
  };
}

export const decisionOf = (out: Record<string, unknown>): string | undefined =>
  (out.hookSpecificOutput as Record<string, string> | undefined)?.permissionDecision;

export const reasonOf = (out: Record<string, unknown>): string =>
  (out.hookSpecificOutput as Record<string, string> | undefined)?.permissionDecisionReason ?? "";

export const contextOf = (out: Record<string, unknown>): string =>
  (out.hookSpecificOutput as Record<string, string> | undefined)?.additionalContext ?? "";

/** A plain directory, not inside any git working tree and with no sddx in its path. */
export function bareDir(): string {
  return mkdtempSync(join(tmpdir(), "plain-"));
}

/** A git repository whose path does not contain "sddx", with or without `.sddx/`,
 * optionally with a config that sets `profile`. */
export function gitRepo(optedIn: boolean, profile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (optedIn) mkdirSync(join(dir, ".sddx"));
  if (profile !== undefined) {
    writeFileSync(join(dir, ".sddx", "config.json"), `${JSON.stringify({ profile }, null, 2)}\n`);
  }
  return dir;
}
