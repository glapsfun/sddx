import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, repoRoot, startTask } from "./helpers";
import { bareDir, decisionOf, gitRepo, reasonOf, runLauncher } from "./hook-launcher";
import { scenario } from "./scenario";

/** A stand-in launcher: runs bun with its arguments when bun is on PATH. */
function probeScript(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "probe-")), "probe");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("the launcher test harness", () => {
  const passThrough = probeScript(
    'if command -v bun >/dev/null 2>&1; then bun "$@"; else echo \'{"nobun":true}\'; fi',
  );

  test("a fake bun records its arguments and stdin, and prints the configured output", () => {
    const r = runLauncher(
      "approval-gate",
      { tool_name: "Bash" },
      {
        cwd: bareDir(),
        bun: { stdout: '{"ok":1}' },
        script: passThrough,
      },
    );
    expect(r.out).toEqual({ ok: 1 });
    expect(r.bunCalls).toEqual(["approval-gate"]);
    expect(JSON.parse(r.bunStdin[0] ?? "")).toEqual({ tool_name: "Bash" });
  });

  test("a fake bun exits with the configured status", () => {
    const r = runLauncher("x", {}, { cwd: bareDir(), bun: { exit: 3 }, script: passThrough });
    expect(r.status).toBe(3);
  });

  test("with no bun, nothing named bun is on PATH or under HOME", () => {
    const r = runLauncher("x", {}, { cwd: bareDir(), bun: "none", script: passThrough });
    expect(r.out).toEqual({ nobun: true });
    expect(r.bunCalls).toEqual([]);
    const probe = runLauncher(
      "x",
      {},
      {
        cwd: bareDir(),
        bun: "none",
        script: probeScript(
          'IFS=:; for d in $PATH; do [ -e "$d/bun" ] && echo "{\\"found\\":\\"$d\\"}" && exit; done; echo "{}"',
        ),
      },
    );
    expect(probe.out).toEqual({});
  });

  test("the real bun runs", () => {
    const r = runLauncher(
      "x",
      {},
      {
        cwd: bareDir(),
        bun: "real",
        script: probeScript("bun -e 'console.log(JSON.stringify({ real: true }))'"),
      },
    );
    expect(r.out).toEqual({ real: true });
  });
});

const bash = (command: string, cwd: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  cwd,
});
const write = (file_path: string, cwd: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path, content: "x" },
  cwd,
});

describe("hooks/run-hook decides before starting Bun", () => {
  scenario("claude-hooks", "Edit in an unrelated repository", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("tdd-gate", write("src/a.ts", cwd), { cwd, bun: { stdout: "{}" } });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({});
    expect(r.bunCalls).toEqual([]);
  });

  scenario("claude-hooks", "Unrelated command skips Bun", () => {
    const r = runLauncher("approval-gate", bash("ls -la", "/work/app"), {
      cwd: bareDir(),
      bun: { stdout: "{}" },
    });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({});
    expect(r.bunCalls).toEqual([]);
  });

  scenario("claude-hooks", "Bundle invoked directly", () => {
    const cwd = gitRepo(false);
    const r = runLauncher(
      "approval-gate",
      bash("bun dist/cli.mjs plan approve .sddx/specs/x.md", cwd),
      { cwd, bun: "real" },
    );
    expect(decisionOf(r.out)).toBe("ask");
  });

  scenario("claude-hooks", "Token forged before opt-in", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("approval-gate", write(".sddx/approvals/abc.json", cwd), {
      cwd,
      bun: "real",
    });
    expect(decisionOf(r.out)).toBe("deny");
  });

  scenario("claude-hooks", "First approval raises the dialog", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("approval-gate", bash("sddx plan approve .sddx/specs/x.md", cwd), {
      cwd,
      bun: "real",
    });
    expect(decisionOf(r.out)).toBe("ask");
  });

  scenario("claude-hooks", "Quoted sddx still reaches the gate", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("approval-gate", bash("s'ddx' plan approve .s'ddx'/specs/x.md", cwd), {
      cwd,
      bun: "real",
    });
    expect(decisionOf(r.out)).toBe("ask");
  });

  scenario("claude-hooks", "Escaped sddx still reaches the gate", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("approval-gate", bash("S\\DDX plan start p.md", cwd), {
      cwd,
      bun: "real",
    });
    expect(decisionOf(r.out)).toBe("ask");
  });

  test("the handler gets the event on stdin and its decision is printed as is", () => {
    const cwd = gitRepo(true, "strict");
    const event = write("src/a.ts", cwd);
    const decision =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}';
    const r = runLauncher("tdd-gate", event, { cwd, bun: { stdout: decision } });
    expect(r.bunCalls).toEqual([`${join(repoRoot, "dist", "hooks.mjs")} tdd-gate`]);
    expect(JSON.parse(r.bunStdin[0] ?? "")).toEqual(event);
    expect(decisionOf(r.out)).toBe("deny");
  });

  scenario("claude-hooks", "Default profile skips Bun", () => {
    for (const profile of [undefined, "default"]) {
      const cwd = gitRepo(true, profile);
      for (const [handler, event] of [
        ["tdd-gate", write("src/a.ts", cwd)],
        ["bash-gate", bash("bun test", cwd)],
        ["record-test", { ...bash("bun test", cwd), tool_response: { exit_code: 1 } }],
      ] as const) {
        const r = runLauncher(handler, event, { cwd, bun: { stdout: "{}" } });
        expect({ handler, out: r.out, bun: r.bunCalls }).toEqual({ handler, out: {}, bun: [] });
      }
    }
  });

  test("any profile other than default, including an invalid one, starts the strict hooks", () => {
    for (const profile of ["strict", "STRICT", "relaxed"]) {
      const cwd = gitRepo(true, profile);
      const r = runLauncher("bash-gate", bash("rm -rf src", cwd), { cwd, bun: { stdout: "{}" } });
      expect({ profile, calls: r.bunCalls.length }).toEqual({ profile, calls: 1 });
    }
  });

  scenario("claude-hooks", "Write into a strict worktree from elsewhere", () => {
    const repo = fixtureRepo();
    writeConfig(repo, { profile: "strict" });
    createRun(repo, { tasks: [{ id: "T1", scope: ["src/**", "tests/**"] }] });
    const worktree = startTask(repo, "T1");
    const elsewhere = bareDir();
    const r = runLauncher("tdd-gate", write(join(worktree, "src", "a.ts"), elsewhere), {
      cwd: elsewhere,
      bun: "real",
    });
    expect(decisionOf(r.out)).toBe("deny");
  });

  scenario("claude-hooks", "cd into a strict repository", () => {
    const strict = gitRepo(true, "strict");
    const elsewhere = bareDir();
    const r = runLauncher("bash-gate", bash(`cd ${strict} && rm -rf src`, elsewhere), {
      cwd: elsewhere,
      bun: { stdout: "{}" },
    });
    expect(r.bunCalls).toHaveLength(1);
  });

  scenario("claude-hooks", "Stop in an unrelated repository", () => {
    const cwd = gitRepo(false);
    const r = runLauncher(
      "stop-gate",
      { hook_event_name: "Stop", cwd },
      {
        cwd,
        bun: { stdout: "{}" },
      },
    );
    expect(r.out).toEqual({});
    expect(r.bunCalls).toEqual([]);
  });
});

describe("hooks/run-hook without Bun, and when the handler fails", () => {
  scenario("claude-hooks", "sddx command without Bun", () => {
    const cwd = gitRepo(true);
    const r = runLauncher("approval-gate", bash("sddx plan start .sddx/specs/x.md", cwd), {
      cwd,
      bun: "none",
    });
    expect(r.status).toBe(0);
    expect(decisionOf(r.out)).toBe("ask");
    expect(reasonOf(r.out)).toContain("Bun");
  });

  scenario("claude-hooks", "Unrelated command without Bun", () => {
    const cwd = gitRepo(false);
    const r = runLauncher("approval-gate", bash("ls", cwd), { cwd, bun: "none" });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({});
  });

  test("every other hook passes through without Bun, even where sddx is in use", () => {
    const cwd = gitRepo(true);
    for (const handler of ["tdd-gate", "bash-gate", "record-test", "stop-gate"]) {
      const r = runLauncher(handler, bash("sddx verify T1", cwd), { cwd, bun: "none" });
      expect(r.status).toBe(0);
      expect(r.out).toEqual({});
    }
  });

  scenario("claude-hooks", "Handler exits 2", () => {
    const cwd = gitRepo(true, "strict");
    const r = runLauncher("bash-gate", bash("rm -rf src", cwd), {
      cwd,
      bun: { stdout: '{"decision":"block"}', exit: 2 },
    });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({});
  });

  scenario("claude-hooks", "Approval handler crashes", () => {
    const cwd = gitRepo(true);
    const r = runLauncher("approval-gate", bash("sddx plan start .sddx/specs/x.md", cwd), {
      cwd,
      bun: { exit: 1 },
    });
    expect(r.status).toBe(0);
    expect(decisionOf(r.out)).toBe("ask");
  });

  test("a handler that prints nothing is a pass-through, and an ask for the approval gate", () => {
    const cwd = gitRepo(true, "strict");
    expect(runLauncher("tdd-gate", write("a.ts", cwd), { cwd, bun: { exit: 0 } }).out).toEqual({});
    const r = runLauncher("approval-gate", bash("sddx plan approve x.md", cwd), {
      cwd,
      bun: { exit: 0 },
    });
    expect(decisionOf(r.out)).toBe("ask");
  });
});
