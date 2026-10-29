import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planHash, writeApproval } from "../src/lib/approval";
import { approvalGate } from "../src/lib/approvalgate";
import { fixtureRepo, writeConfig } from "./fixtures";
import { goalSpec, repoRoot, writeSpec } from "./helpers";

const HOOKS_SRC = join(repoRoot, "src/hooks.ts");

/** Runs the real dispatcher end-to-end, the way Claude Code would. */
function dispatch(cwd: string, sub: string, event: Record<string, unknown>, env = process.env) {
  const r = spawnSync("bun", [HOOKS_SRC, sub], {
    cwd,
    input: JSON.stringify(event),
    encoding: "utf8",
    env,
  });
  return { status: r.status, out: JSON.parse(r.stdout || "{}"), raw: r.stdout };
}

const decisionOf = (out: Record<string, unknown>): string | undefined =>
  (out.hookSpecificOutput as Record<string, string> | undefined)?.permissionDecision;

/** A goal spec with `tasks` disjoint tasks; returns its repo-relative path. */
function planRepo(cwd: string, tasks = 2): string {
  return writeSpec(
    cwd,
    "2026-01-01-ship-the-widget",
    goalSpec({
      title: "ship the widget",
      tasks: Array.from({ length: tasks }, (_, i) => ({ id: `T${i}`, scope: [`src/n${i}/**`] })),
    }),
  );
}

const startCmd = (rel: string) => `sddx plan start ${rel}`;

describe("approval gate decisions", () => {
  test("human mode with no token asks, naming the plan digest and task count", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    writeConfig(cwd, { interaction_mode: "human" });

    const d = approvalGate({ command: startCmd(rel), cwd });
    expect(d.decision).toBe("ask");
    expect(d.reason).toContain(planHash(join(cwd, rel)).hash.slice(0, 12));
    expect(d.reason).toContain("2 tasks");
  });

  test("a valid token passes through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });
    writeApproval(cwd, { plan_sha256: planHash(join(cwd, rel)).hash, mode: "human" });

    expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("pass");
  });

  test("auto mode within bounds passes through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    writeConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 6 });
    expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("pass");
  });

  test("auto mode over the ceiling does not ask; the CLI refuses instead", () => {
    // A bound no longer arms this gate. Asking here would invite the human to
    // approve a plan the CLI is about to reject outright, so the hook stays
    // silent and lets the command exit non-zero with the reason.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 4);
    writeConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 2 });
    const d = approvalGate({ command: startCmd(rel), cwd });
    expect(d.decision).toBe("pass");
  });

  test("commands other than starting or approving a plan are not the gate's business", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });
    expect(approvalGate({ command: "bun test", cwd }).decision).toBe("pass");
    expect(approvalGate({ command: "sddx board", cwd }).decision).toBe("pass");
    // a check creates nothing, so it never needs approval
    expect(approvalGate({ command: `sddx plan check ${rel}`, cwd }).decision).toBe("pass");
  });

  test("SECURITY: `plan approve` ALWAYS asks; it is the human act itself", () => {
    // An ungated approve lets the model write its own token and then sail through
    // the start gate on the strength of it, making human mode a no-op that
    // reports itself satisfied. No mode and no existing token pre-satisfies this.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    for (const mode of ["human", "auto"] as const) {
      writeConfig(cwd, { interaction_mode: mode });
      const d = approvalGate({ command: `sddx plan approve ${rel}`, cwd });
      expect(d.decision).toBe("ask");
      expect(d.reason).toContain("YOUR approval");
    }
    // even with a token already on disk
    writeApproval(cwd, { plan_sha256: planHash(join(cwd, rel)).hash, mode: "human" });
    expect(approvalGate({ command: `sddx plan approve ${rel}`, cwd }).decision).toBe("ask");
  });

  test("SECURITY: the environment cannot switch the gate's mode", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    writeConfig(cwd, { interaction_mode: "human" });
    process.env.SDDX_INTERACTION_MODE = "auto";
    try {
      expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("ask");
    } finally {
      delete process.env.SDDX_INTERACTION_MODE;
    }
  });

  test("SECURITY: only a real `plan check` is exempt, judged per segment", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    writeConfig(cwd, { interaction_mode: "human" });
    // the CLI ignores an unknown flag, so this performs a REAL start and must be gated
    expect(approvalGate({ command: `${startCmd(rel)} --dry-run`, cwd }).decision).toBe("ask");
    // a check in one segment must not vouch for a real start in the next
    expect(
      approvalGate({ command: `sddx plan check ${rel} && ${startCmd(rel)}`, cwd }).decision,
    ).toBe("ask");
    // nor may a comment
    expect(approvalGate({ command: `${startCmd(rel)} # sddx plan check`, cwd }).decision).toBe(
      "ask",
    );
    // a genuine check still passes
    expect(approvalGate({ command: `sddx plan check ${rel}`, cwd }).decision).toBe("pass");
  });
});

describe("the approval gate fails closed", () => {
  test("corrupt config asks rather than passing through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), "{not json");
    // an unreadable config resolves to human mode, and human with no token asks
    expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("ask");
  });

  test("an unreadable plan asks rather than passing through", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto" });
    const d = approvalGate({ command: startCmd(".sddx/specs/2026-01-01-missing.md"), cwd });
    expect(d.decision).toBe("ask");
  });

  test("an unreadable approval token is treated as absent, never as approval", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });
    const { hash } = planHash(join(cwd, rel));
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "approvals", `${hash}.json`), "{not json");
    expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("ask");
  });

  test("an internal throw asks rather than passing through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });
    // make the approvals dir unreadable so the lookup throws rather than returns
    const dir = join(cwd, ".sddx", "approvals");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    try {
      expect(approvalGate({ command: startCmd(rel), cwd }).decision).toBe("ask");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a missing command passes; a start with no spec asks", () => {
    expect(approvalGate({ command: undefined, cwd: undefined }).decision).toBe("pass");
    const cwd = fixtureRepo();
    planRepo(cwd);
    expect(approvalGate({ command: "sddx plan start", cwd }).decision).toBe("ask");
  });
});

describe("dispatcher wiring", () => {
  test("emits an ask permission decision and exits 0", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });

    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: startCmd(rel) },
    });
    expect(r.status).toBe(0);
    expect(decisionOf(r.out)).toBe("ask");
    expect((r.out.hookSpecificOutput as Record<string, string>).hookEventName).toBe("PreToolUse");
    expect(
      (r.out.hookSpecificOutput as Record<string, string>).permissionDecisionReason,
    ).toBeTruthy();
  });

  test("REGRESSION: the approval gate emits ask, never a bare pass-through, when approval is required", () => {
    // The prohibition gates (tdd-gate, bash-gate) deliberately never emit a
    // permission decision on the allow path: "never auto-approve". A permission
    // gate is the opposite shape: it MUST emit "ask" to raise the dialog. If a
    // future consistency cleanup makes this gate silent, human mode becomes a
    // no-op and this test is what says so.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });

    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: startCmd(rel) },
    });
    expect(r.out.hookSpecificOutput).toBeDefined();
    expect(decisionOf(r.out)).toBe("ask");
    expect(decisionOf(r.out)).not.toBe("allow");
    expect(r.raw).not.toBe("{}\n");
  });

  test("passes through silently when approval is not required", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 6 });
    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: startCmd(rel) },
    });
    expect(r.status).toBe(0);
    expect(decisionOf(r.out)).toBeUndefined();
  });

  test("malformed stdin does not crash and does not silently allow", () => {
    const cwd = fixtureRepo();
    const r = spawnSync("bun", [HOOKS_SRC, "approval-gate"], {
      cwd,
      input: "{not json",
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision).not.toBe("allow");
  });
});

describe("hot paths", () => {
  test("SessionStart does no approval work and stays fast", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    writeConfig(cwd, { interaction_mode: "human" });
    const started = performance.now();
    const r = dispatch(cwd, "session-start", { cwd });
    const elapsed = performance.now() - started;
    expect(r.status).toBe(0);
    // the router's prose mentions approval; what must be absent is a gate decision
    // or the plan digest a gate would have computed
    expect(decisionOf(r.out)).toBeUndefined();
    expect(JSON.stringify(r.out)).not.toContain(planHash(join(cwd, rel)).hash.slice(0, 12));
    // generous vs. the 200ms budget: this spawns a fresh bun process too
    expect(elapsed).toBeLessThan(3000);
  });
});
