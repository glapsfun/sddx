// `bun run evals`: lists the catalog, or runs a selection of scenarios in real
// harness sessions and writes a report. Every refusal (an unknown name, CI,
// missing credentials, Codex without the full-access acknowledgement, a Codex
// home whose hooks would not trust) happens before the first session starts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fillPrompt, SCENARIOS } from "./catalog";
import { FIXTURES, type RunResult } from "./fixtures";
import { GRADERS } from "./graders";
import {
  claudeArgs,
  codexArgs,
  prepareClaudeHome,
  prepareCodexHome,
  runProcess,
  sessionEnv,
  shippedCopy,
} from "./harness";
import { type RunMeta, renderJson, renderMarkdown, stripper } from "./report";
import { snapshot, workingTree } from "./snapshot";
import { readClaudeTranscript, readCodexTranscript, runsSddx } from "./transcript";
import {
  HARNESSES,
  type Harness,
  type HarnessInfo,
  type Scenario,
  type SessionResult,
  type Transcript,
  type Verdict,
} from "./types";

export interface RunnerIo {
  out(line: string): void;
  err(line: string): void;
}

export interface RunnerOptions {
  checkout: string;
  outDir: string;
  /** Where the run's directory goes; defaults to `~/.cache/sddx-evals`. */
  tmpRoot?: string;
  /** The CLI fixtures and snapshots run, as argv; defaults to the checkout's `bin/sddx`. */
  sddx?: string[];
  scenarios?: Scenario[];
  now?: () => Date;
}

const BIN: Record<Harness, string> = { "claude-code": "claude", codex: "codex" };

const FULL_ACCESS = [
  "Codex sessions need --codex-full-access: `codex exec` cannot ask for sandbox escalation, and",
  "sddx writes .git, so they run with --sandbox danger-full-access. The agent can then write",
  "anywhere you can. Run the evals on a disposable machine or in a container.",
].join("\n");

class Refusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

interface Session {
  scenario: Scenario;
  harness: Harness;
  run: number;
}

interface Selection {
  sessions: Session[];
  harnesses: Harness[];
}

function select(
  values: { scenario?: string[]; harness?: string; runs?: string },
  catalog: Scenario[],
): Selection {
  const runs = Number(values.runs ?? "1");
  if (!Number.isInteger(runs) || runs < 1)
    throw new Refusal(`--runs must be a positive integer`, 2);
  let harnesses = [...HARNESSES];
  if (values.harness && values.harness !== "all") {
    if (!HARNESSES.includes(values.harness as Harness)) {
      throw new Refusal(`unknown harness: ${values.harness} (claude-code, codex or all)`, 2);
    }
    harnesses = [values.harness as Harness];
  }
  const chosen = new Set<Scenario>();
  for (const v of values.scenario ?? ["all"]) {
    const matches = catalog.filter((s) => v === "all" || s.name === v || s.group === v);
    if (matches.length === 0) throw new Refusal(`unknown scenario or group: ${v}`, 2);
    for (const s of matches) chosen.add(s);
  }
  const sessions: Session[] = [];
  for (const scenario of chosen) {
    for (const harness of harnesses.filter((h) => scenario.harnesses.includes(h))) {
      for (let run = 1; run <= runs; run++) sessions.push({ scenario, harness, run });
    }
  }
  if (sessions.length === 0) throw new Refusal("that selection starts no session", 2);
  return { sessions, harnesses: harnesses.filter((h) => sessions.some((s) => s.harness === h)) };
}

function list(catalog: Scenario[], io: RunnerIo): void {
  const total = catalog.reduce((n, s) => n + s.harnesses.length, 0);
  io.out(
    `${catalog.length} scenarios; the whole catalog starts ${total} sessions at one run each.`,
  );
  io.out("");
  const width = Math.max(...catalog.map((s) => s.name.length));
  for (const s of catalog) {
    io.out(`  ${s.name.padEnd(width)}  ${s.group.padEnd(9)}  ${s.harnesses.join(", ")}`);
  }
  io.out("");
  io.out("Run with --scenario <name|group|all> and/or --harness <claude-code|codex|all>.");
}

function models(values: string[] | undefined): Partial<Record<Harness, string>> {
  const out: Partial<Record<Harness, string>> = {};
  for (const v of values ?? []) {
    const [h, m] = [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)];
    if (!v.includes("=") || !HARNESSES.includes(h as Harness) || m === "") {
      throw new Refusal(`--model takes <claude-code|codex>=<model>, got: ${v}`, 2);
    }
    out[h as Harness] = m;
  }
  return out;
}

function version(bin: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(bin, ["--version"], { env, encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n")[0] || "unknown";
}

function git(cwd: string, ...args: string[]): string {
  return (spawnSync("git", args, { cwd, encoding: "utf8" }).stdout ?? "").trim();
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: RunnerIo,
  opts: RunnerOptions,
): Promise<number> {
  const catalog = opts.scenarios ?? SCENARIOS;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        scenario: { type: "string", multiple: true },
        harness: { type: "string" },
        runs: { type: "string" },
        model: { type: "string", multiple: true },
        timeout: { type: "string" },
        "claude-auth": { type: "string" },
        "codex-auth": { type: "string" },
        "codex-full-access": { type: "boolean" },
      },
      strict: true,
    }) as { values: Record<string, string | string[] | boolean | undefined> };
    if (values.scenario === undefined && values.harness === undefined) {
      list(catalog, io);
      return 0;
    }
    const sel = select(
      {
        scenario: values.scenario as string[] | undefined,
        harness: values.harness as string | undefined,
        runs: values.runs as string | undefined,
      },
      catalog,
    );
    const named = models(values.model as string[] | undefined);
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeout !== undefined && !(timeout > 0)) throw new Refusal("--timeout takes minutes", 2);
    if (env.CI) {
      throw new Refusal(
        "evals run locally only: they start paid model sessions, so CI never runs them",
        1,
      );
    }
    const bins: Partial<Record<Harness, string>> = {};
    for (const h of sel.harnesses) {
      const bin = Bun.which(BIN[h], { PATH: env.PATH ?? "" });
      if (!bin) throw new Refusal(`${BIN[h]} is not on PATH`, 1);
      bins[h] = bin;
    }
    const claudeAuth = values["claude-auth"] as string | undefined;
    const codexAuth = values["codex-auth"] as string | undefined;
    for (const f of [claudeAuth, codexAuth]) {
      if (f && !existsSync(f)) throw new Refusal(`no such auth file: ${f}`, 1);
    }
    if (
      sel.harnesses.includes("claude-code") &&
      !env.ANTHROPIC_API_KEY &&
      !env.CLAUDE_CODE_OAUTH_TOKEN &&
      !claudeAuth
    ) {
      throw new Refusal(
        "no Claude Code credentials: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or name a credentials file with --claude-auth",
        1,
      );
    }
    if (sel.harnesses.includes("codex")) {
      if (!values["codex-full-access"]) throw new Refusal(FULL_ACCESS, 1);
      if (!env.OPENAI_API_KEY && !codexAuth) {
        throw new Refusal(
          "no Codex credentials: set OPENAI_API_KEY, or name an auth.json with --codex-auth",
          1,
        );
      }
    }
    return await run(sel, { env, io, opts, bins, named, timeout, claudeAuth, codexAuth });
  } catch (e) {
    if (e instanceof Refusal) {
      io.err(e.message);
      return e.code;
    }
    if (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(e.message);
      return 2;
    }
    io.err(`evals: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

interface RunContext {
  env: NodeJS.ProcessEnv;
  io: RunnerIo;
  opts: RunnerOptions;
  bins: Partial<Record<Harness, string>>;
  named: Partial<Record<Harness, string>>;
  timeout?: number;
  claudeAuth?: string;
  codexAuth?: string;
}

async function run(sel: Selection, ctx: RunContext): Promise<number> {
  const { env, io, opts } = ctx;
  const started = (opts.now ?? (() => new Date()))();
  // not under the system temp directory: Codex creates no helper binaries for a home there
  const root =
    opts.tmpRoot ?? join(env.XDG_CACHE_HOME || join(env.HOME ?? tmpdir(), ".cache"), "sddx-evals");
  mkdirSync(root, { recursive: true });
  const runDir = mkdtempSync(join(root, "run-"));
  io.out(`Starting ${sel.sessions.length} session(s); raw transcripts go to ${runDir}`);

  const userEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
  delete userEnv.CODEX_TOOL_CALL_ID;
  const sddxArgv = opts.sddx ?? [join(opts.checkout, "bin", "sddx")];
  const sddx = (cwd: string, ...args: string[]): RunResult => {
    const [cmd, ...pre] = sddxArgv as [string, ...string[]];
    const r = spawnSync(cmd, [...pre, ...args], { cwd, env: userEnv, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const templates: Partial<Record<Harness, string>> = {};
  const info: Partial<Record<Harness, HarnessInfo>> = {};
  for (const h of sel.harnesses) {
    const template = join(runDir, "homes", h);
    const bin = ctx.bins[h] as string;
    const tEnv = { ...sessionEnv(env, template), CODEX_HOME: template };
    if (h === "claude-code") prepareClaudeHome(template, ctx.claudeAuth);
    else {
      const source = shippedCopy(opts.checkout, join(runDir, "plugin-source"));
      await prepareCodexHome(bin, source, template, tEnv, {
        file: ctx.codexAuth,
        apiKey: ctx.codexAuth ? undefined : env.OPENAI_API_KEY,
      });
    }
    templates[h] = template;
    info[h] = { version: version(bin, tEnv), model: ctx.named[h] ?? "default" };
  }

  const results: SessionResult[] = [];
  const homes = [env.HOME ?? "", join(runDir, "homes")];
  const fixtures: string[] = [];
  for (const [i, s] of sel.sessions.entries()) {
    const dir = join(
      runDir,
      "sessions",
      `${String(i + 1).padStart(3, "0")}-${s.harness}-${s.scenario.name}-${s.run}`,
    );
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(repo, { recursive: true });
    fixtures.push(repo);
    homes.push(home);
    io.out(`[${i + 1}/${sel.sessions.length}] ${s.scenario.name} in ${s.harness}, run ${s.run}`);
    const result = await session(s, {
      dir,
      repo,
      home,
      sddx,
      ctx,
      template: templates[s.harness] as string,
    });
    const model = result.model;
    if (model && info[s.harness]?.model === "default")
      (info[s.harness] as HarnessInfo).model = model;
    results.push(result.result);
    io.out(
      `  ${result.result.outcome}${result.result.reasons.length ? `: ${result.result.reasons[0]}` : ""}`,
    );
  }

  const strip = stripper(homes.filter(Boolean), fixtures);
  const clean = results.map((r) => ({
    ...r,
    reasons: r.reasons.map(strip),
    commands: r.commands.map(strip),
    reply: strip(r.reply),
  }));
  const meta: RunMeta = {
    started,
    commit: git(opts.checkout, "rev-parse", "--short", "HEAD") || "unknown",
    dirty: git(opts.checkout, "status", "--porcelain") !== "",
    harnesses: info,
  };
  mkdirSync(opts.outDir, { recursive: true });
  const name = started.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  let base = join(opts.outDir, name);
  for (let n = 2; existsSync(`${base}.md`); n++) base = join(opts.outDir, `${name}-${n}`);
  writeFileSync(`${base}.md`, renderMarkdown(meta, clean));
  writeFileSync(`${base}.json`, renderJson(meta, clean));
  io.out(`Report: ${base}.md and ${base}.json`);
  return 0;
}

const MAX_REPLY = 4000;

async function session(
  s: Session,
  x: {
    dir: string;
    repo: string;
    home: string;
    sddx: (cwd: string, ...a: string[]) => RunResult;
    ctx: RunContext;
    template: string;
  },
): Promise<{ result: SessionResult; model?: string }> {
  const { scenario, harness, run: n } = s;
  const { ctx } = x;
  const base = { scenario: scenario.name, group: scenario.group, harness, run: n };
  const fixture = FIXTURES[scenario.fixture];
  const grader = GRADERS[scenario.grader];
  if (!fixture || !grader) throw new Error(`${scenario.name}: unknown fixture or grader`);
  const fx = fixture(x.repo, {
    sddx: x.sddx,
    mode: scenario.mode,
    v5Archive: join(ctx.opts.checkout, "tests", "fixtures", "v5-repo.tar.gz"),
  });
  const before = workingTree(x.repo);
  cpSync(x.template, x.home, { recursive: true });
  const env = sessionEnv(ctx.env, x.home);
  if (harness === "codex") env.CODEX_HOME = x.home;
  let marker: string | null = null;
  if (scenario.decoy) {
    const bin = join(x.dir, "decoy-bin");
    marker = join(x.dir, "decoy-called");
    mkdirSync(bin);
    writeFileSync(join(bin, "sddx"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH ?? ""}`;
  }
  const prompt = fillPrompt(scenario.prompt, fx);
  const model = ctx.named[harness];
  const args =
    harness === "claude-code"
      ? claudeArgs(prompt, ctx.opts.checkout, model)
      : codexArgs(prompt, x.repo, model);
  const minutes = ctx.timeout ?? scenario.minutes;
  const transcriptFile = join(x.dir, "transcript.jsonl");
  const exit = await runProcess(ctx.bins[harness] as string, args, {
    cwd: x.repo,
    env,
    timeoutMs: minutes * 60_000,
    stdout: transcriptFile,
    stderr: join(x.dir, "stderr.txt"),
  });
  const error = (reason: string) => ({
    result: {
      ...base,
      outcome: "error" as const,
      reasons: [reason],
      commands: [],
      reply: "",
      seconds: exit.seconds,
    },
  });
  if (exit.timedOut) return error(`timed out after ${minutes} minutes`);
  if (exit.exit !== 0) return error(`${BIN[harness]} exited ${exit.exit ?? "on a signal"}`);
  let transcript: Transcript;
  try {
    const text = readFileSync(transcriptFile, "utf8");
    transcript = harness === "claude-code" ? readClaudeTranscript(text) : readCodexTranscript(text);
  } catch (e) {
    return error(`unreadable transcript: ${e instanceof Error ? e.message : String(e)}`);
  }
  let verdict: Verdict;
  try {
    verdict = grader(snapshot(x.repo, before, x.sddx, transcript, marker), fx);
  } catch (e) {
    return error(`could not read the end state: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    model: transcript.model,
    result: {
      ...base,
      outcome: verdict.pass ? "pass" : "fail",
      reasons: verdict.reasons,
      commands: transcript.commands.map((c) => c.command).filter(runsSddx),
      reply: transcript.reply.slice(0, MAX_REPLY),
      ...(transcript.tokens ? { tokens: transcript.tokens } : {}),
      seconds: exit.seconds,
    },
  };
}
