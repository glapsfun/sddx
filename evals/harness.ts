// Starting a headless session in each harness, from a throwaway home. Claude
// Code loads the plugin straight from the checkout and allows tools by rule,
// so the approval gate's `ask` is refused as it is for any user who is not
// there to answer. Codex gets a home where the plugin was installed from the
// checkout and its hooks trusted, because Codex runs no hook it has not been
// told to trust.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** The maintainer's environment for a session: harness and agent markers dropped, home replaced. */
export function sessionEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(CODEX_|CLAUDECODE$|CLAUDE_CODE_(?!OAUTH_TOKEN$))/.test(k)) continue;
    out[k] = v;
  }
  return {
    ...out,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

export const CLAUDE_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Agent",
  "Task",
  "Skill",
  "TodoWrite",
];

/**
 * A credentials file as a session may see it. From a Claude Code file, only the
 * Claude login, without its refresh token: other tokens (MCP logins) stay out of
 * reach, and no session can rotate the maintainer's refresh token.
 */
export function sessionCredentials(text: string): string {
  try {
    const login = (JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    if (login && typeof login === "object") {
      const { refreshToken: _, ...rest } = login;
      return `${JSON.stringify({ claudeAiOauth: rest })}\n`;
    }
  } catch {
    // not JSON: copied as it is
  }
  return text;
}

export function prepareClaudeHome(home: string, authFile?: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (!authFile) return;
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    sessionCredentials(readFileSync(authFile, "utf8")),
    { mode: 0o600 },
  );
}

export function claudeArgs(prompt: string, checkout: string, model?: string): string[] {
  return [
    "-p",
    prompt,
    "--plugin-dir",
    checkout,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--allowedTools",
    CLAUDE_TOOLS.join(","),
    ...(model ? ["--model", model] : []),
  ];
}

export function codexArgs(prompt: string, fixture: string, model?: string): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "-C",
    fixture,
    ...(model ? ["-m", model] : []),
    prompt,
  ];
}

/** The files git would ship from the checkout: tracked plus new, ignored ones left out. */
export function shippedCopy(checkout: string, dest: string): string {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${checkout}: ${r.stderr}`);
  for (const rel of r.stdout.split("\0").filter(Boolean)) {
    const from = join(checkout, rel);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(from, join(dest, rel));
  }
  return dest;
}

export interface HookEntry {
  key: string;
  currentHash: string;
  trustStatus: string;
  pluginId: string | null;
}

/** Asks `codex app-server` for `hooks/list`, giving up after `timeoutMs`. */
export async function listHooks(
  codex: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 60_000,
): Promise<HookEntry[]> {
  const proc = Bun.spawn([codex, "app-server"], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const send = (msg: Record<string, unknown>) =>
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "sddx-evals", version: "0" } },
    });
    send({ method: "initialized" });
    send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
    await proc.stdin.flush();
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: { data?: { hooks: HookEntry[] }[] };
        };
        if (msg.id === 2 && msg.result) return (msg.result.data ?? []).flatMap((e) => e.hooks);
      }
    }
    throw new Error("codex app-server closed before answering hooks/list");
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

const tomlString = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The `config.toml` table that marks one hook trusted: its key, and its hash before the `/`. */
export function trustEntry(h: Pick<HookEntry, "key" | "currentHash">): string {
  const hash = h.currentHash.split("/")[0] ?? h.currentHash;
  return `\n[hooks.state.${tomlString(h.key)}]\ntrusted_hash = ${tomlString(hash)}\n`;
}

export const SDDX_PLUGIN_ID = "sddx@sddx";

export interface CodexAuth {
  file?: string;
  apiKey?: string;
}

/**
 * Builds a Codex home: credentials, the plugin installed from a shipped copy of
 * the checkout, and every sddx hook trusted. Throws unless `hooks/list` then
 * reports each sddx hook trusted, so a change in how Codex records trust stops
 * the run instead of running untrusted hooks.
 */
export async function prepareCodexHome(
  codex: string,
  pluginSource: string,
  home: string,
  env: NodeJS.ProcessEnv,
  auth: CodexAuth,
): Promise<void> {
  mkdirSync(home, { recursive: true });
  const run = (args: string[], input?: string) => {
    const r = spawnSync(codex, args, { cwd: home, env, encoding: "utf8", input });
    if (r.status !== 0) throw new Error(`codex ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  };
  if (auth.file) copyFileSync(auth.file, join(home, "auth.json"));
  else if (auth.apiKey) run(["login", "--with-api-key"], auth.apiKey);
  run(["plugin", "marketplace", "add", pluginSource]);
  run(["plugin", "add", SDDX_PLUGIN_ID]);
  const ours = (await listHooks(codex, env, home)).filter((h) => h.pluginId === SDDX_PLUGIN_ID);
  if (ours.length === 0) throw new Error("Codex lists no sddx hooks after installing the plugin");
  for (const h of ours) appendFileSync(join(home, "config.toml"), trustEntry(h));
  const after = (await listHooks(codex, env, home)).filter((h) => h.pluginId === SDDX_PLUGIN_ID);
  const untrusted = after.filter((h) => h.trustStatus !== "trusted");
  if (after.length !== ours.length || untrusted.length > 0) {
    throw new Error(
      `Codex did not accept the hook trust entries: ${untrusted.map((h) => `${h.key} is ${h.trustStatus}`).join(", ") || "hooks changed"}`,
    );
  }
}

export interface SessionExit {
  exit: number | null;
  timedOut: boolean;
  seconds: number;
}

/** Runs one session in its own process group, writing stdout and stderr to files. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdout: string; stderr: string },
): Promise<SessionExit> {
  const out = openSync(opts.stdout, "w");
  const err = openSync(opts.stderr, "w");
  const started = Date.now();
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, opts.timeoutMs);
  return new Promise((resolve) => {
    let finished = false;
    const done = (exit: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup();
      closeSync(out);
      closeSync(err);
      resolve({ exit, timedOut, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.on("error", () => done(null));
    child.on("exit", (code) => done(code));
  });
}
