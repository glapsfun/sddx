// Stand-ins for the `claude` and `codex` CLIs, so the eval runner is tested end
// to end without a model. Each stub records how it was called, then plays a
// session: an optional shell script run in the session's directory (to leave
// an end state), a sleep, a transcript on stdout and an exit code. The Codex
// stub also answers `plugin`, `login` and `app-server` `hooks/list`, reporting
// a hook trusted only when `config.toml` holds the entry Codex would accept.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "../evals/catalog";
import { main } from "../evals/runner";
import type { Scenario } from "../evals/types";
import { CLI, repoRoot } from "./helpers";

export interface StubBehavior {
  /** Bash commands the default transcript reports, and its final reply. */
  commands?: string[];
  reply?: string;
  /** Printed instead of the default transcript, by either harness, with `{CWD}` and
   * `{HOME}` replaced by the session's directory and home. */
  transcript?: string;
  script?: string;
  sleepMs?: number;
  exit?: number;
  neverTrust?: boolean;
}

export interface StubCall {
  name: string;
  argv: string[];
  cwd: string;
  /** HOME, CODEX_HOME, PATH and XDG_* as the stub saw them. */
  env: Record<string, string>;
  envKeys: string[];
}

const SNAKE: Record<string, string> = {
  SessionStart: "session_start",
  PreToolUse: "pre_tool_use",
  Stop: "stop",
  SubagentStop: "subagent_stop",
};

/** The hooks Codex lists for the plugin: one key per entry of hooks/hooks-codex.json. */
export function stubHooks(): { key: string; currentHash: string }[] {
  const file = JSON.parse(readFileSync(join(repoRoot, "hooks", "hooks-codex.json"), "utf8"));
  const out: { key: string; currentHash: string }[] = [];
  for (const [event, groups] of Object.entries(file.hooks) as [string, { hooks: unknown[] }[]][]) {
    groups.forEach((g, i) => {
      g.hooks.forEach((_, j) => {
        const key = `sddx@sddx:hooks/hooks-codex.json:${SNAKE[event]}:${i}:${j}`;
        const hex = Buffer.from(key).toString("hex").slice(0, 64).padEnd(64, "0");
        out.push({ key, currentHash: `sha256:${hex}/sha256:${"0".repeat(64)}` });
      });
    });
  }
  return out;
}

const STUB = `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
const dir = import.meta.dir;
const name = basename(process.argv[1]);
const cfg = JSON.parse(readFileSync(join(dir, "behavior.json"), "utf8"));
const argv = process.argv.slice(2);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (/^(HOME|CODEX_HOME|PATH|XDG_.*)$/.test(k)) env[k] = v;
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ name, argv, cwd: process.cwd(), env, envKeys: Object.keys(process.env) }) + "\\n");
if (argv[0] === "--version") { console.log(name + " 0.0.0-stub"); process.exit(0); }
if (name === "codex" && (argv[0] === "plugin" || argv[0] === "login")) process.exit(0);
if (name === "codex" && argv[0] === "app-server") {
  const config = join(process.env.CODEX_HOME ?? "", "config.toml");
  const toml = existsSync(config) ? readFileSync(config, "utf8") : "";
  const trusted = (h) => !cfg.neverTrust && toml.includes('[hooks.state."' + h.key + '"]\\ntrusted_hash = "' + h.currentHash.split("/")[0] + '"');
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk;
    const lines = buf.split("\\n");
    buf = lines.pop();
    for (const line of lines) {
      const m = JSON.parse(line);
      if (m.id === undefined) continue;
      const result = m.method === "hooks/list"
        ? { data: [{ cwd: process.cwd(), hooks: cfg.hooks.map((h) => ({ ...h, pluginId: "sddx@sddx", trustStatus: trusted(h) ? "trusted" : "untrusted" })) }] }
        : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    }
  }
  process.exit(0);
}
const cwd = name === "codex" ? argv[argv.indexOf("-C") + 1] : process.cwd();
if (cfg.script) spawnSync("sh", ["-c", cfg.script], { cwd, stdio: "ignore" });
if (cfg.sleepMs) await Bun.sleep(cfg.sleepMs);
process.stdout.write(cfg.transcripts[name].replaceAll("{CWD}", cwd).replaceAll("{HOME}", process.env.HOME ?? ""));
process.exit(cfg.exit ?? 0);
`;

export interface Stubs {
  dir: string;
  calls(): StubCall[];
  /** Calls that ran a session: `claude -p` or `codex exec`. */
  sessions(): StubCall[];
}

export function stubHarnesses(behavior: StubBehavior = {}): Stubs {
  const dir = mkdtempSync(join(tmpdir(), "sddx-stub-"));
  const transcripts = {
    claude: behavior.transcript ?? claudeTranscript(behavior.commands, behavior.reply),
    codex: behavior.transcript ?? codexTranscript(behavior.commands, behavior.reply),
  };
  writeFileSync(
    join(dir, "behavior.json"),
    JSON.stringify({ ...behavior, transcripts, hooks: stubHooks() }),
  );
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(dir, name), STUB);
    chmodSync(join(dir, name), 0o755);
  }
  const calls = (): StubCall[] => {
    const f = join(dir, "calls.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StubCall);
  };
  return {
    dir,
    calls,
    sessions: () =>
      calls().filter(
        (c) =>
          (c.name === "claude" && c.argv[0] === "-p") ||
          (c.name === "codex" && c.argv[0] === "exec"),
      ),
  };
}

/** A minimal Claude Code `stream-json` transcript: the given Bash commands, then a reply. */
export function claudeTranscript(commands: string[] = [], reply = "done"): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", model: "claude-stub-1" }];
  commands.forEach((command, i) => {
    lines.push({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] },
    });
    lines.push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "", is_error: false }],
      },
    });
  });
  lines.push({
    type: "result",
    subtype: "success",
    result: reply,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** A minimal Codex `exec --json` transcript: the given commands, then a reply. */
export function codexTranscript(commands: string[] = [], reply = "done"): string {
  const lines: unknown[] = [
    { type: "thread.started", thread_id: "stub" },
    { type: "turn.started" },
  ];
  commands.forEach((command, i) => {
    lines.push({
      type: "item.completed",
      item: {
        id: `item_${i}`,
        type: "command_execution",
        command: `/bin/bash -lc '${command.replaceAll("'", `'\\''`)}'`,
        aggregated_output: "",
        exit_code: 0,
        status: "completed",
      },
    });
  });
  lines.push({
    type: "item.completed",
    item: { id: "item_r", type: "agent_message", text: reply },
  });
  lines.push({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
  });
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

export interface EvalsRun {
  code: number;
  out: string;
  err: string;
  outDir: string;
  tmpRoot: string;
  stubs: Stubs;
}

export async function runEvals(
  argv: string[],
  o: {
    behavior?: StubBehavior;
    env?: Record<string, string | undefined>;
    scenarios?: Scenario[];
    home?: string;
  } = {},
): Promise<EvalsRun> {
  const stubs = stubHarnesses(o.behavior);
  const tmpRoot = mkdtempSync(join(tmpdir(), "sddx-evals-test-"));
  const outDir = join(tmpRoot, "out");
  const home = o.home ?? join(tmpRoot, "maintainer");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: `${stubs.dir}:${process.env.PATH}`,
    HOME: home,
    ANTHROPIC_API_KEY: "sk-test",
    OPENAI_API_KEY: "sk-test",
    ...o.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    env,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    {
      checkout: repoRoot,
      outDir,
      tmpRoot,
      sddx: ["bun", CLI],
      ...(o.scenarios ? { scenarios: o.scenarios } : {}),
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n"), outDir, tmpRoot, stubs };
}

/** The scenario named, from the real catalog. */
export function catalogScenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}

/** The JSON report a run wrote to `outDir`. */
export function readReport(outDir: string): {
  sessions: { outcome: string; reasons: string[]; commands: string[]; reply: string }[];
  summary: { scenario: string; harness: string; runs: number; pass: number; fail: number }[];
  harnesses: Record<string, { version: string; model: string }>;
  commit: string;
} {
  const f = readdirSync(outDir).find((n) => n.endsWith(".json"));
  if (!f) throw new Error(`no JSON report in ${outDir}`);
  return JSON.parse(readFileSync(join(outDir, f), "utf8"));
}
