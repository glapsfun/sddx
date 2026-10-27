// The approval gate as Codex runs it: patches are judged by the files they
// write, and every "ask" becomes a "deny" that hands the command to the user.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookOutput } from "../src/lib/hookdispatch";
import { fixtureRepo } from "./fixtures";
import { createRun, goalSpec, repoRoot, sddx, startTask, writeSpec } from "./helpers";
import { scenario } from "./scenario";

const HOOKS_SRC = join(repoRoot, "src/hooks.ts");

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

/** Runs the real dispatcher, as the launcher does, optionally as Codex with plugin root /p. */
function gate(cwd: string, event: Record<string, unknown>, harness?: "codex"): HookOut {
  const r = spawnSync("bun", [HOOKS_SRC, "approval-gate", ...(harness ? [harness] : [])], {
    cwd,
    input: JSON.stringify({ cwd, ...event }),
    encoding: "utf8",
    env: { ...process.env, PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p" },
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout || "{}") as HookOut;
}

const decision = (out: HookOut) => out.hookSpecificOutput?.permissionDecision;
const reason = (out: HookOut) => out.hookSpecificOutput?.permissionDecisionReason ?? "";

const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
const applyPatch = (text: string) => ({ tool_name: "apply_patch", tool_input: { command: text } });
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const heredoc = (text: string) => `apply_patch <<'EOF'\n${text}\nEOF`;

const twoTasks = () =>
  goalSpec({
    tasks: [
      { id: "T1", scope: ["src/a/**"] },
      { id: "T2", scope: ["src/b/**"] },
    ],
  });

describe("patches are judged by the files they write", () => {
  scenario("plan-approval", "Patch forging an approval token", () => {
    const out = gate(
      fixtureRepo(),
      applyPatch(patch("*** Add File: .sddx/approvals/abc.json", "+{}")),
    );
    expect(decision(out)).toBe("deny");
  });

  scenario("plan-approval", "Heredoc patch through the shell", () => {
    const text = patch("*** Update File: .sddx/config.json", "@@", "-{}", '+{"profile":"default"}');
    expect(decision(gate(fixtureRepo(), bash(heredoc(text))))).toBe("deny");
  });

  scenario("plan-approval", "Ordinary patch", () => {
    const text = patch(
      "*** Update File: src/a.ts",
      "@@",
      " // run sddx plan approve .sddx/specs/x.md first",
      "-old()",
      "+next()",
    );
    expect(gate(fixtureRepo(), applyPatch(text))).toEqual({});
  });

  test("a move into a protected path, an absolute path, and a cd-relative path are denied", () => {
    const cwd = fixtureRepo();
    const moved = patch("*** Update File: notes.json", "*** Move to: .sddx/approvals/x.json");
    expect(decision(gate(cwd, applyPatch(moved)))).toBe("deny");
    const absolute = patch(`*** Add File: ${join(cwd, ".git", "sddx-proofs", "T1.json")}`, "+{}");
    expect(decision(gate(cwd, applyPatch(absolute)))).toBe("deny");
    const relative = patch("*** Add File: approvals/x.json", "+{}");
    expect(decision(gate(cwd, bash(`cd .sddx && ${heredoc(relative)}`)))).toBe("deny");
  });

  test("the shell around a heredoc is still judged as shell", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, "2026-01-01-test-goal", twoTasks());
    const text = patch("*** Update File: src/a.ts", "@@", "-a", "+b");
    const chained = `apply_patch <<'EOF' && sddx plan approve ${spec}\n${text}\nEOF`;
    expect(decision(gate(cwd, bash(chained)))).toBe("ask");
    const after = `${heredoc(text)}\nsddx plan approve ${spec}`;
    expect(decision(gate(cwd, bash(after)))).toBe("ask");
    // with no terminator the shell reads to the end, so the whole line is judged
    const open = `apply_patch <<'EOF'\n${text}\nEOF && sddx plan approve ${spec}`;
    expect(decision(gate(cwd, bash(open)))).toBe("ask");
  });

  test("a heredoc that does not feed apply_patch is judged as before", () => {
    const cwd = fixtureRepo();
    const out = gate(cwd, bash("cat > .sddx/config.json <<'EOF'\n{}\nEOF"));
    expect(decision(out)).toBe("deny");
  });
});

describe("the approval gate in Codex", () => {
  scenario("codex-hooks", "Agent-run approval denied", () => {
    const out = gate(fixtureRepo(), bash("sddx plan approve .sddx/specs/x.md"), "codex");
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain("!/p/bin/sddx plan approve .sddx/specs/x.md");
  });

  scenario("plan-approval", "Approve command in Codex is handed to the user", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, "2026-01-01-test-goal", twoTasks());
    const out = gate(cwd, bash(`sddx plan approve ${spec}`), "codex");
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain(`!/p/bin/sddx plan approve ${spec}`);
  });

  scenario("codex-hooks", "Start without approval denied", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, "2026-01-01-test-goal", twoTasks());
    const out = gate(cwd, bash(`sddx plan start ${spec}`), "codex");
    expect(decision(out)).toBe("deny");
    expect(reason(out)).toContain(`!/p/bin/sddx plan approve ${spec}`);
  });

  scenario("codex-hooks", "Start with approval passes", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, "2026-01-01-test-goal", twoTasks());
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(0);
    expect(gate(cwd, bash(`sddx plan start ${spec}`), "codex")).toEqual({});
  });

  test("a deny stays a deny, and Claude Code still gets ask", () => {
    const cwd = fixtureRepo();
    const forged = { tool_name: "Write", tool_input: { file_path: ".sddx/approvals/a.json" } };
    expect(decision(gate(cwd, forged, "codex"))).toBe("deny");
    expect(decision(gate(cwd, bash("sddx plan approve .sddx/specs/x.md")))).toBe("ask");
  });

  scenario("codex-hooks", "Gate corpus in Codex", () => {
    const literals = (file: string): string[] => {
      const text = readFileSync(join(repoRoot, "tests", file), "utf8");
      const out = new Set<string>();
      for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
        const s = (m[1] ?? m[2] ?? "").replace(/\\(["'\\])/g, "$1");
        if (s.trim().length > 1) out.add(s);
      }
      return [...out];
    };
    const corpus = [...literals("approval-gate.test.ts"), ...literals("approval-bypass.test.ts")];
    expect(corpus.length).toBeGreaterThan(100);
    const cwd = fixtureRepo();
    const allowed = new Set(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    const offenders: string[] = [];
    for (const s of corpus) {
      for (const event of [
        bash(s),
        { tool_name: "Write", tool_input: { file_path: s } },
        applyPatch(patch(`*** Update File: ${s}`)),
      ]) {
        const out = hookOutput("approval-gate", { cwd, ...event }, "codex");
        const keys = Object.keys(out);
        const inner = (out.hookSpecificOutput ?? {}) as Record<string, unknown>;
        const bad =
          keys.some((k) => k !== "systemMessage" && k !== "hookSpecificOutput") ||
          Object.keys(inner).some((k) => !allowed.has(k)) ||
          (out.hookSpecificOutput !== undefined && inner.hookEventName !== "PreToolUse") ||
          (inner.permissionDecision !== undefined && inner.permissionDecision !== "deny");
        if (bad) offenders.push(`${event.tool_name}: ${s} -> ${JSON.stringify(out)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  scenario("codex-hooks", "Stop block shape", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    const out = hookOutput("stop-gate", { cwd: wt }, "codex");
    expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).not.toBe("");
  });
});
