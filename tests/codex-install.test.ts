// Installs the plugin into a throwaway Codex home and asks Codex's app server
// what it loaded: the skills, and exactly the hooks in hooks/hooks-codex.json.
// Needs no account and no model. CI installs Codex and sets SDDX_REQUIRE_CODEX,
// so only a local run may skip.
import { describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";
import { SKILLS } from "./skill-contract";

/** The codex CLI to run, null to skip; throws when CI requires it and it is missing. */
export function codexOrSkip(found: string | null, env: NodeJS.ProcessEnv): string | null {
  if (found) return found;
  if (env.SDDX_REQUIRE_CODEX === "1") {
    throw new Error("SDDX_REQUIRE_CODEX=1 but the codex CLI is not on PATH");
  }
  console.warn("codex CLI not on PATH; skipping the Codex install check");
  return null;
}

/** The files git would ship: tracked plus new ones, without ignored ones like node_modules. */
function shippedCopy(): string {
  const dest = mkdtempSync(join(tmpdir(), "codex-src-"));
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  for (const rel of r.stdout.split("\0").filter(Boolean)) {
    const from = join(repoRoot, rel);
    if (!existsSync(from)) continue; // deleted in the working tree
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(from, join(dest, rel));
  }
  return dest;
}

interface HookEntry {
  eventName: string;
  matcher: string | null;
  command: string;
  timeoutSec: number;
  pluginId?: string;
  sourcePath?: string;
}

/** Asks `codex app-server` for skills/list and hooks/list in `cwd`. */
async function listFromAppServer(
  codex: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ skills: string[]; hooks: HookEntry[] }> {
  const proc = Bun.spawn([codex, "app-server"], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const send = (msg: Record<string, unknown>) =>
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "sddx-test", version: "0" } },
  });
  send({ method: "initialized" });
  send({ id: 2, method: "skills/list", params: { cwds: [cwd] } });
  send({ id: 3, method: "hooks/list", params: { cwds: [cwd] } });
  await proc.stdin.flush();
  const results = new Map<number, Record<string, unknown>>();
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of proc.stdout) {
    buffered += decoder.decode(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
      if (msg.id !== undefined && msg.result) results.set(msg.id, msg.result);
    }
    if (results.has(2) && results.has(3)) break;
  }
  proc.kill();
  const data = (id: number) => (results.get(id)?.data ?? []) as Record<string, unknown>[];
  return {
    skills: data(2).flatMap((e) => (e.skills as { name: string }[]).map((s) => s.name)),
    hooks: data(3).flatMap((e) => e.hooks as HookEntry[]),
  };
}

const EVENT_NAMES: Record<string, string> = {
  SessionStart: "sessionStart",
  PreToolUse: "preToolUse",
  Stop: "stop",
  SubagentStop: "subagentStop",
};

describe("the plugin as Codex installs it", () => {
  scenario(
    "codex-plugin",
    "Install into an empty Codex home",
    async () => {
      const codex = codexOrSkip(Bun.which("codex"), process.env);
      if (!codex) return;
      const home = mkdtempSync(join(tmpdir(), "codex-home-"));
      const work = mkdtempSync(join(tmpdir(), "codex-work-"));
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: work });
      const env = { ...process.env, CODEX_HOME: home };
      for (const args of [
        ["plugin", "marketplace", "add", shippedCopy()],
        ["plugin", "add", "sddx@sddx"],
      ]) {
        const r = spawnSync(codex, args, { cwd: work, env, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`codex ${args.join(" ")} failed:\n${r.stderr}`);
      }

      const { skills, hooks } = await listFromAppServer(codex, env, work);
      expect(skills.filter((s) => s.startsWith("sddx:")).sort()).toEqual(
        SKILLS.map((s) => `sddx:${s}`).sort(),
      );

      const ours = hooks.filter((h) => h.pluginId === "sddx@sddx");
      const file = JSON.parse(readFileSync(join(repoRoot, "hooks", "hooks-codex.json"), "utf8"));
      const expected: string[] = [];
      for (const [event, groups] of Object.entries(file.hooks) as [
        string,
        { matcher?: string; hooks: { command: string; timeout: number }[] }[],
      ][]) {
        for (const g of groups) {
          for (const h of g.hooks) {
            const handler = h.command.split(" ").at(-2);
            expected.push(`${EVENT_NAMES[event]} ${g.matcher ?? "*"} ${handler} ${h.timeout}`);
          }
        }
      }
      const listed = ours.map(
        (h) => `${h.eventName} ${h.matcher ?? "*"} ${h.command.split(" ").at(-2)} ${h.timeoutSec}`,
      );
      expect(listed.sort()).toEqual(expected.sort());
      for (const h of ours) {
        expect(h.sourcePath?.endsWith(join("hooks", "hooks-codex.json"))).toBe(true);
        expect(h.command.endsWith(" codex")).toBe(true);
      }
    },
    120_000,
  );

  scenario("codex-plugin", "Codex missing in CI", () => {
    expect(() => codexOrSkip(null, { SDDX_REQUIRE_CODEX: "1" })).toThrow("codex CLI");
  });

  scenario("codex-plugin", "Codex missing locally", () => {
    expect(codexOrSkip(null, {})).toBeNull();
    expect(codexOrSkip("/usr/bin/codex", { SDDX_REQUIRE_CODEX: "1" })).toBe("/usr/bin/codex");
  });
});
