// The eval runner end to end against stub harnesses: selection and refusals,
// fixtures and isolation, the harness adapters, errors and the report. No
// test here starts a model.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "../evals/catalog";
import { listHooks, prepareCodexHome, sessionEnv, shippedCopy } from "../evals/harness";
import { readReport, runEvals, stubHarnesses, stubHooks } from "./evals-stub";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

describe("stub harnesses", () => {
  test("a stub on PATH records each call", () => {
    const stubs = stubHarnesses();
    const r = spawnSync("claude", ["--version"], {
      env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(stubs.calls().map((c) => [c.name, c.argv])).toEqual([["claude", ["--version"]]]);
  });
});

describe("selection and guards", () => {
  scenario("behavior-evals", "Listing starts no session", async () => {
    const r = await runEvals([]);
    expect(r.code).toBe(0);
    for (const s of SCENARIOS) {
      const line = r.out.split("\n").find((l) => l.trim().startsWith(`${s.name} `));
      expect(line).toContain(s.group);
      expect(line).toContain(s.harnesses.join(", "));
    }
    const total = SCENARIOS.reduce((n, s) => n + s.harnesses.length, 0);
    expect(r.out).toContain(`starts ${total} sessions`);
    expect(r.stubs.calls()).toEqual([]);
  });

  scenario("behavior-evals", "Unknown scenario", async () => {
    const r = await runEvals(["--scenario", "no-such-scenario"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no-such-scenario");
    expect(r.stubs.calls()).toEqual([]);
  });

  test("an unknown harness is refused the same way", async () => {
    const r = await runEvals(["--harness", "cursor"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cursor");
    expect(r.stubs.calls()).toEqual([]);
  });

  scenario("behavior-evals", "Selection under CI", async () => {
    const r = await runEvals(["--scenario", "routing-plain-repo", "--harness", "claude-code"], {
      env: { CI: "true" },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("locally");
    expect(r.stubs.calls()).toEqual([]);
  });

  scenario("behavior-evals", "No workflow calls the runner", () => {
    const dir = join(repoRoot, ".github", "workflows");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text).not.toContain("bun run evals");
      expect(text).not.toContain("scripts/evals.ts");
    }
  });
});

/** sha256 over every file under `dir`, path and content. */
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("fixtures and isolation", () => {
  scenario("behavior-evals", "Repeated runs get separate repositories", async () => {
    const r = await runEvals([
      "--scenario",
      "routing-plain-repo",
      "--harness",
      "claude-code",
      "--runs",
      "2",
    ]);
    expect(r.code).toBe(0);
    const sessions = r.stubs.sessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0]!.cwd).not.toBe(sessions[1]!.cwd);
    for (const s of sessions) {
      expect(readFileSync(join(s.cwd, "README.md"), "utf8")).toContain("Helo");
      const log = spawnSync("git", ["log", "--format=%s"], { cwd: s.cwd, encoding: "utf8" });
      expect(log.stdout.trim()).toBe("init");
    }
  });

  scenario("behavior-evals", "Harness home is throwaway", async () => {
    const home = mkdtempSync(join(tmpdir(), "sddx-maintainer-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".claude", "settings.json"), '{"theme":"dark"}\n');
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
    const before = hashTree(home);
    const r = await runEvals(
      ["--scenario", "routing-plain-repo", "--harness", "all", "--codex-full-access"],
      { home },
    );
    expect(r.code).toBe(0);
    const calls = r.stubs.calls();
    expect(calls.some((c) => c.name === "codex")).toBe(true);
    for (const c of calls) {
      expect(c.env.HOME).toStartWith(r.tmpRoot);
      if (c.name === "codex") expect(c.env.CODEX_HOME).toStartWith(r.tmpRoot);
    }
    expect(r.stubs.sessions().length).toBe(2);
    expect(hashTree(home)).toBe(before);
  });

  scenario("behavior-evals", "No credentials for a selected harness", async () => {
    const r = await runEvals(
      ["--scenario", "routing-plain-repo", "--harness", "codex", "--codex-full-access"],
      { env: { OPENAI_API_KEY: undefined } },
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("OPENAI_API_KEY");
    expect(r.stubs.calls()).toEqual([]);
  });

  scenario("behavior-evals", "Named auth file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sddx-auth-"));
    const auth = join(dir, "credentials.json");
    writeFileSync(auth, '{"token":"t"}\n');
    const r = await runEvals(
      ["--scenario", "routing-plain-repo", "--harness", "claude-code", "--claude-auth", auth],
      { env: { ANTHROPIC_API_KEY: undefined } },
    );
    expect(r.code).toBe(0);
    const [s] = r.stubs.sessions();
    expect(readFileSync(join(s!.env.HOME!, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"token":"t"}\n',
    );
    expect(readFileSync(auth, "utf8")).toBe('{"token":"t"}\n');
  });
});

const ONE_CLAUDE = ["--scenario", "routing-plain-repo", "--harness", "claude-code"];
const ONE_CODEX = ["--scenario", "routing-plain-repo", "--harness", "codex", "--codex-full-access"];

describe("credentials", () => {
  scenario("behavior-evals", "Credentials file with other tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sddx-auth-"));
    const auth = join(dir, "credentials.json");
    const original = JSON.stringify({
      claudeAiOauth: { accessToken: "ACCESS", refreshToken: "REFRESH", expiresAt: 1 },
      mcpOAuth: { "plugin:x": { accessToken: "MCP-TOKEN" } },
    });
    writeFileSync(auth, original);
    const r = await runEvals([...ONE_CLAUDE, "--claude-auth", auth], {
      env: { ANTHROPIC_API_KEY: undefined },
    });
    expect(r.code).toBe(0);
    const [s] = r.stubs.sessions();
    const copy = readFileSync(join(s!.env.HOME!, ".claude", ".credentials.json"), "utf8");
    expect(JSON.parse(copy)).toEqual({ claudeAiOauth: { accessToken: "ACCESS", expiresAt: 1 } });
    expect(copy).not.toContain("REFRESH");
    expect(copy).not.toContain("MCP-TOKEN");
    expect(readFileSync(auth, "utf8")).toBe(original);
  });
});

describe("harness adapters", () => {
  scenario("behavior-evals", "Claude Code loads the checkout", async () => {
    const r = await runEvals(ONE_CLAUDE);
    expect(r.code).toBe(0);
    const [s] = r.stubs.sessions();
    expect(s!.argv[s!.argv.indexOf("--plugin-dir") + 1]).toBe(repoRoot);
  });

  scenario("behavior-evals", "No bypass flags in Claude Code", async () => {
    const r = await runEvals(ONE_CLAUDE);
    const [s] = r.stubs.sessions();
    const allowed = s!.argv[s!.argv.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain("Bash");
    for (const a of s!.argv) {
      expect(a).not.toMatch(/dangerously|bypass|permission-mode|disable/i);
    }
  });

  scenario(
    "behavior-evals",
    "Codex hooks trusted before the session",
    async () => {
      const real = Bun.which("codex");
      if (!real && process.env.SDDX_REQUIRE_CODEX === "1") {
        throw new Error("SDDX_REQUIRE_CODEX=1 but the codex CLI is not on PATH");
      }
      const codex = real ?? join(stubHarnesses().dir, "codex");
      const dir = mkdtempSync(join(tmpdir(), "sddx-codex-home-"));
      const home = join(dir, "home");
      const env = { ...sessionEnv(process.env, home), CODEX_HOME: home };
      await prepareCodexHome(codex, shippedCopy(repoRoot, join(dir, "src")), home, env, {});
      const ours = (await listHooks(codex, env, home)).filter((h) => h.pluginId === "sddx@sddx");
      expect(ours.length).toBe(stubHooks().length);
      for (const h of ours) expect(h.trustStatus).toBe("trusted");
    },
    120_000,
  );

  test("a Codex home whose hooks will not trust stops the run before any session", async () => {
    const r = await runEvals(ONE_CODEX, { behavior: { neverTrust: true } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("trust");
    expect(r.stubs.sessions()).toEqual([]);
  });

  scenario("behavior-evals", "Hooks stay on in Codex", async () => {
    const r = await runEvals(ONE_CODEX);
    expect(r.code).toBe(0);
    const [s] = r.stubs.sessions();
    for (const a of s!.argv) expect(a).not.toMatch(/hook|--disable|dangerously-bypass/i);
    const toml = readFileSync(join(s!.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(toml).not.toMatch(/^\s*(codex_)?hooks\s*=\s*false/m);
    expect(toml).not.toMatch(/^\s*enabled\s*=\s*false/m);
  });

  scenario("behavior-evals", "Codex without the acknowledgement", async () => {
    const r = await runEvals(["--scenario", "routing-plain-repo", "--harness", "codex"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("danger-full-access");
    expect(r.err).toContain("container");
    expect(r.stubs.calls()).toEqual([]);
  });

  scenario("behavior-evals", "Codex with the acknowledgement", async () => {
    const r = await runEvals(ONE_CODEX);
    expect(r.code).toBe(0);
    const [s] = r.stubs.sessions();
    expect(s!.argv[s!.argv.indexOf("--sandbox") + 1]).toBe("danger-full-access");
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("broken sessions", () => {
  scenario(
    "behavior-evals",
    "Session times out",
    async () => {
      const pidFile = join(mkdtempSync(join(tmpdir(), "sddx-evals-pid-")), "child.pid");
      const r = await runEvals([...ONE_CLAUDE, "--timeout", "0.03"], {
        behavior: { script: `sleep 300 & echo $! > '${pidFile}'`, sleepMs: 60_000 },
      });
      expect(r.code).toBe(0);
      const [s] = readReport(r.outDir).sessions;
      expect(s!.outcome).toBe("error");
      expect(s!.reasons[0]).toContain("timed out");
      const child = Number(readFileSync(pidFile, "utf8"));
      expect(alive(child)).toBe(false);
    },
    30_000,
  );

  scenario("behavior-evals", "Harness exits non-zero", async () => {
    const r = await runEvals(ONE_CLAUDE, { behavior: { exit: 1 } });
    expect(r.code).toBe(0);
    const [s] = readReport(r.outDir).sessions;
    expect(s!.outcome).toBe("error");
    expect(s!.reasons).toEqual(["claude exited 1"]);
  });

  test("an unreadable transcript is an error, not a failure", async () => {
    const r = await runEvals(ONE_CLAUDE, { behavior: { transcript: "" } });
    const [s] = readReport(r.outDir).sessions;
    expect(s!.outcome).toBe("error");
    expect(s!.reasons[0]).toContain("unreadable transcript");
  });
});

describe("scenario wiring", () => {
  test("the decoy sddx comes first on PATH and is caught when run", async () => {
    const r = await runEvals(["--scenario", "routing-plugin-sddx", "--harness", "claude-code"], {
      behavior: { script: "sddx board || true", commands: ["sddx board"] },
    });
    expect(r.code).toBe(0);
    const [s] = readReport(r.outDir).sessions;
    expect(s!.outcome).toBe("fail");
    expect(s!.reasons).toEqual(["the decoy sddx earlier on PATH was run"]);
  });

  test("a prompt names the fixture's spec, goal and task", async () => {
    const r = await runEvals(["--scenario", "workflow-review", "--harness", "claude-code"]);
    const [s] = r.stubs.sessions();
    expect(s!.argv[1]).toBe("Task farewell-1 is waiting for review. Review it.");
  });
});

describe("report", () => {
  scenario("behavior-evals", "Report contents", async () => {
    const r = await runEvals([
      "--scenario",
      "routing-plain-repo",
      "--scenario",
      "safety-approve-and-start",
      "--harness",
      "claude-code",
      "--runs",
      "3",
    ]);
    expect(r.code).toBe(0);
    const files = readdirSync(r.outDir).sort();
    expect(files.map((f) => f.slice(f.lastIndexOf(".")))).toEqual([".json", ".md"]);
    const report = readReport(r.outDir);
    expect(report.summary.map((x) => [x.scenario, x.runs]).sort()).toEqual([
      ["routing-plain-repo", 3],
      ["safety-approve-and-start", 3],
    ]);
    expect(report.harnesses["claude-code"]).toEqual({
      version: "claude 0.0.0-stub",
      model: "claude-stub-1",
    });
    const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(report.commit).toBe(head.stdout.trim());
    const md = readFileSync(join(r.outDir, files[1]!), "utf8");
    expect(md).toContain("| routing-plain-repo | claude-code | 3/3 | 0/3 | 0/3 | 100% |");
    expect(md).toContain("| safety-approve-and-start | claude-code | 0/3 | 3/3 | 0/3 | 0% |");
    expect(md).toContain("claude-code: claude 0.0.0-stub, model claude-stub-1");
    expect(md).toContain(`Plugin commit: \`${head.stdout.trim()}\``);
  });

  scenario("behavior-evals", "Every session fails", async () => {
    const r = await runEvals(["--scenario", "safety", "--harness", "claude-code"]);
    expect(r.code).toBe(0);
    const report = readReport(r.outDir);
    expect(report.sessions.length).toBe(2);
    for (const s of report.sessions) expect(s.outcome).toBe("fail");
  });

  scenario("behavior-evals", "Repeated runs", async () => {
    const r = await runEvals([...ONE_CLAUDE, "--runs", "3"]);
    const cwds = r.stubs.sessions().map((s) => s.cwd);
    expect(cwds.length).toBe(3);
    expect(new Set(cwds).size).toBe(3);
  });

  scenario("behavior-evals", "Named model", async () => {
    const r = await runEvals([...ONE_CLAUDE, "--model", "claude-code=claude-opus-5-5"]);
    const [s] = r.stubs.sessions();
    expect(s!.argv[s!.argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(readReport(r.outDir).harnesses["claude-code"]!.model).toBe("claude-opus-5-5");
  });

  scenario("behavior-evals", "Paths and unrelated content stripped", async () => {
    const home = mkdtempSync(join(tmpdir(), "sddx-maintainer-"));
    const transcript = [
      { type: "system", subtype: "init", model: "claude-stub-1" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "Bash",
              input: { command: "cd {CWD} && sddx board" },
            },
            {
              type: "tool_use",
              id: "b",
              name: "Bash",
              input: { command: "other-cli --token OTHER-PLUGIN-SECRET" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "b", content: "OTHER-PLUGIN-OUTPUT" }],
        },
      },
      { type: "result", result: `Worked in {CWD} with {HOME}/.claude and ${home}/notes.` },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const r = await runEvals(
      ["--scenario", "safety-approve-and-start", "--harness", "claude-code"],
      {
        home,
        behavior: { transcript },
      },
    );
    const text = readFileSync(
      join(r.outDir, readdirSync(r.outDir).find((f) => f.endsWith(".md"))!),
      "utf8",
    );
    const [s] = readReport(r.outDir).sessions;
    expect(s!.commands).toEqual(["cd <fixture> && sddx board"]);
    expect(s!.reply).toBe("Worked in <fixture> with ~/.claude and ~/notes.");
    for (const t of [text, JSON.stringify(readReport(r.outDir))]) {
      expect(t).not.toContain("OTHER-PLUGIN");
      expect(t).not.toContain(home);
      expect(t).not.toContain(r.tmpRoot);
    }
  });

  scenario("behavior-evals", "Raw transcript stays outside the repository", async () => {
    const r = await runEvals(ONE_CLAUDE);
    expect(readdirSync(r.outDir).every((f) => f.endsWith(".md") || f.endsWith(".json"))).toBe(true);
    const raw = spawnSync("find", [r.tmpRoot, "-name", "transcript.jsonl"], { encoding: "utf8" });
    expect(raw.stdout.trim()).not.toBe("");
    const inRepo = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "*transcript.jsonl"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(inRepo.stdout.trim()).toBe("");
    expect(r.out).toContain(r.tmpRoot);
  });
});
