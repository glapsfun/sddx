import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planHash, writeApproval } from "../src/lib/approval";
import { approvalGate } from "../src/lib/approvalgate";
import { fixtureRepo } from "./fixtures";
import { GRAPH_HEADER_LINES, repoRoot } from "./helpers";

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

const SPEC = (task: string, scope: string) => `task: ${task}
success_criteria:
  - "it works"
scope:
  - "${scope}"
oracle:
  type: command
  run: "true"
`;

function planRepo(cwd: string, nodes = 2): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = [...GRAPH_HEADER_LINES, "goal: ship the widget", "tasks:"];
  for (let i = 0; i < nodes; i++) {
    writeFileSync(join(drafts, `n${i}.yaml`), SPEC(`build part ${i}`, `src/n${i}/**`));
    lines.push(`  - alias: n${i}`, `    spec: n${i}.yaml`);
  }
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

const createCmd = (rel: string) => `sddx graph create --graph ${rel}`;

function withConfig(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify(config));
}

describe("approval gate decisions", () => {
  test("human mode with no token asks, naming the plan digest and node count", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    withConfig(cwd, { interaction_mode: "human" });

    const d = approvalGate({ command: createCmd(rel), cwd });
    expect(d.decision).toBe("ask");
    expect(d.reason).toContain(planHash(join(cwd, rel)).hash.slice(0, 12));
    expect(d.reason).toContain("2 nodes");
  });

  test("a valid token passes through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });
    writeApproval(cwd, { plan_sha256: planHash(join(cwd, rel)).hash, mode: "human" });

    expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("pass");
  });

  test("auto mode within bounds passes through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    withConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 6 });
    expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("pass");
  });

  test("auto mode over the ceiling does not ask — the CLI refuses instead", () => {
    // A bound no longer arms this gate. Asking here would invite the human to
    // approve a plan the CLI is about to reject outright, so the hook stays
    // silent and lets the command exit non-zero with the reason.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 4);
    withConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 2 });
    const d = approvalGate({ command: createCmd(rel), cwd });
    expect(d.decision).toBe("pass");
  });

  test("commands other than plan creation are not the gate's business", () => {
    const cwd = fixtureRepo();
    planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });
    expect(approvalGate({ command: "bun test", cwd }).decision).toBe("pass");
    expect(approvalGate({ command: "sddx board", cwd }).decision).toBe("pass");
    // a dry run creates nothing, so it never needs approval
    expect(
      approvalGate({ command: "sddx graph create --graph g.yaml --dry-run", cwd }).decision,
    ).toBe("pass");
  });

  test("SECURITY: `graph approve` ALWAYS asks — it is the human act itself", () => {
    // An ungated approve lets the model write its own token and then sail through
    // the create gate on the strength of it, making human mode a no-op that
    // reports itself satisfied. No mode and no existing token pre-satisfies this.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    for (const mode of ["human", "auto"] as const) {
      withConfig(cwd, { interaction_mode: mode });
      const d = approvalGate({ command: `sddx graph approve --graph ${rel}`, cwd });
      expect(d.decision).toBe("ask");
      expect(d.reason).toContain("YOUR approval");
    }
    // even with a token already on disk
    writeApproval(cwd, { plan_sha256: planHash(join(cwd, rel)).hash, mode: "human" });
    expect(approvalGate({ command: `sddx graph approve --graph ${rel}`, cwd }).decision).toBe(
      "ask",
    );
  });

  test("SECURITY: the environment cannot switch the gate's mode", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    withConfig(cwd, { interaction_mode: "human" });
    process.env.SDDX_INTERACTION_MODE = "auto";
    try {
      expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("ask");
    } finally {
      delete process.env.SDDX_INTERACTION_MODE;
    }
  });

  test("SECURITY: --dry-run is matched as an exact token in the right segment", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd, 2);
    withConfig(cwd, { interaction_mode: "human" });
    // `--dry-run=false` is not `--dry-run`; the CLI's args.includes agrees, so
    // this command performs a REAL create and must be gated
    expect(approvalGate({ command: `${createCmd(rel)} --dry-run=false`, cwd }).decision).toBe(
      "ask",
    );
    // a dry run in one segment must not vouch for a real create in the next
    expect(
      approvalGate({ command: `${createCmd(rel)} --dry-run && ${createCmd(rel)}`, cwd }).decision,
    ).toBe("ask");
    // nor may a comment
    expect(approvalGate({ command: `${createCmd(rel)} # --dry-run`, cwd }).decision).toBe("ask");
    // a genuine dry run still passes
    expect(approvalGate({ command: `${createCmd(rel)} --dry-run`, cwd }).decision).toBe("pass");
  });
});

describe("the approval gate fails closed", () => {
  test("corrupt config asks rather than passing through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), "{not json");
    // an unreadable config resolves to human mode, and human with no token asks
    expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("ask");
  });

  test("an unreadable plan asks rather than passing through", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "auto" });
    const d = approvalGate({ command: "sddx graph create --graph .sddx/drafts/missing.yaml", cwd });
    expect(d.decision).toBe("ask");
  });

  test("an unreadable approval token is treated as absent, never as approval", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });
    const { hash } = planHash(join(cwd, rel));
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "approvals", `${hash}.json`), "{not json");
    expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("ask");
  });

  test("an internal throw asks rather than passing through", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });
    // make the approvals dir unreadable so the lookup throws rather than returns
    const dir = join(cwd, ".sddx", "approvals");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    try {
      expect(approvalGate({ command: createCmd(rel), cwd }).decision).toBe("ask");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("a missing cwd or command asks", () => {
    expect(approvalGate({ command: undefined, cwd: undefined }).decision).toBe("pass");
    const cwd = fixtureRepo();
    planRepo(cwd);
    expect(approvalGate({ command: "sddx graph create", cwd }).decision).toBe("ask");
  });
});

describe("dispatcher wiring", () => {
  test("emits an ask permission decision and exits 0", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });

    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: createCmd(rel) },
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
    // permission decision on the allow path — "never auto-approve". A permission
    // gate is the opposite shape: it MUST emit "ask" to raise the dialog. If a
    // future consistency cleanup makes this gate silent, human mode becomes a
    // no-op and this test is what says so.
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });

    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: createCmd(rel) },
    });
    expect(r.out.hookSpecificOutput).toBeDefined();
    expect(decisionOf(r.out)).toBe("ask");
    expect(decisionOf(r.out)).not.toBe("allow");
    expect(r.raw).not.toBe("{}\n");
  });

  test("passes through silently when approval is not required", () => {
    const cwd = fixtureRepo();
    const rel = planRepo(cwd);
    withConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 6 });
    const r = dispatch(cwd, "approval-gate", {
      cwd,
      tool_name: "Bash",
      tool_input: { command: createCmd(rel) },
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

describe("hook registration", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "hooks/hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };

  test("the approval gate is registered on PreToolUse Bash", () => {
    const entries = manifest.hooks.PreToolUse.flatMap((e) =>
      e.hooks.map((h) => ({ matcher: e.matcher, command: h.command })),
    );
    const gate = entries.find((e) => e.command.includes("approval-gate"));
    expect(gate).toBeDefined();
    expect(gate?.matcher).toBe("Bash");
    expect(gate?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  test("the approval gate is NOT on SessionStart or any other hot path", () => {
    for (const event of ["SessionStart", "PostToolUse", "Stop", "SubagentStop"]) {
      const commands = (manifest.hooks[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));
      for (const c of commands) expect(c).not.toContain("approval-gate");
    }
  });

  test("SessionStart does no approval work and stays fast", () => {
    const cwd = fixtureRepo();
    planRepo(cwd);
    withConfig(cwd, { interaction_mode: "human" });
    const started = performance.now();
    const r = dispatch(cwd, "session-start", { cwd });
    const elapsed = performance.now() - started;
    expect(r.status).toBe(0);
    expect(JSON.stringify(r.out)).not.toContain("approval");
    // generous vs. the 200ms budget: this spawns a fresh bun process too
    expect(elapsed).toBeLessThan(3000);
  });
});
