// M3 oracle: drive dist/hooks.mjs exactly as Claude Code does — event JSON on
// stdin, decision JSON on stdout — and prove the TDD gate's guarantees end to end.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "../src/lib/receipt";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const HOOKS = join(repoRoot, "dist", "hooks.mjs");
const CLI = join(repoRoot, "src", "cli.ts");

interface HookResult {
  exitCode: number;
  output: Record<string, unknown>;
  raw: string;
}

function runHook(sub: string, event: unknown, runtime: "bun" | "node" = "bun"): HookResult {
  const r = spawnSync(runtime, [HOOKS, sub], {
    input: typeof event === "string" ? event : JSON.stringify(event),
    encoding: "utf8",
  });
  const raw = (r.stdout ?? "").trim();
  return { exitCode: r.status ?? -1, output: raw === "" ? {} : JSON.parse(raw), raw };
}

const denyReason = (res: HookResult): string => {
  const h = res.output.hookSpecificOutput as Record<string, unknown> | undefined;
  expect(h?.permissionDecision).toBe("deny");
  return String(h?.permissionDecisionReason);
};

const isPassThrough = (res: HookResult): boolean =>
  (res.output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision ===
  undefined;

function sddx(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SPEC_YAML = `task: prove the gate
context: []
success_criteria:
  - "oracle exits 0"
oracle:
  type: command
  run: "true"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
`;

/** Fixture repo with one registered no-workspace task; returns [repo, taskId]. */
function repoWithTask(): { repo: string; id: string } {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "spec.yaml"), SPEC_YAML);
  const r = sddx(repo, "task", "create", "--spec", "spec.yaml", "--workspace", "none");
  expect(r.status).toBe(0);
  const id = /created (\S+) /.exec(r.stdout)?.[1] as string;
  expect(id).toBeDefined();
  return { repo, id };
}

const editEvent = (cwd: string, filePath: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: filePath },
  cwd,
  unknown_future_field: { nested: true },
});

const bashEvent = (cwd: string, command: string, exitCode: number) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { exit_code: exitCode },
  cwd,
});

describe("hook I/O contract (5.1)", () => {
  test("deny decision is JSON on stdout with exit 0", () => {
    const { repo } = repoWithTask();
    const res = runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts")));
    expect(res.exitCode).toBe(0);
    expect(denyReason(res)).toContain("failing test");
  });

  test("malformed stdin yields a no-op, never a crash", () => {
    const res = runHook("tdd-gate", "{not json");
    expect(res.exitCode).toBe(0);
    expect(isPassThrough(res)).toBe(true);
  });

  test("unknown subcommand reports a diagnostic, exit 0", () => {
    const res = runHook("frobnicate", {});
    expect(res.exitCode).toBe(0);
    expect(String(res.output.systemMessage)).toContain("unknown subcommand");
  });

  test("gate decisions are identical under plain node (launcher fallback)", () => {
    const { repo } = repoWithTask();
    const bunRes = runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts")), "bun");
    const nodeRes = runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts")), "node");
    expect(nodeRes.exitCode).toBe(0);
    expect(denyReason(nodeRes)).toBe(denyReason(bunRes));
  });
});

describe("implementation-first is hard-blocked (5.2)", () => {
  test("blocked in the main checkout, in PLAN and in RED", () => {
    const { repo, id } = repoWithTask();
    expect(denyReason(runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts"))))).toContain(
      id,
    );
    expect(sddx(repo, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    const res = runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts")));
    expect(denyReason(res)).toContain("RED");
  });

  test("identical block inside a task worktree", () => {
    const { clone } = fixtureClone();
    writeFileSync(join(clone, "spec.yaml"), SPEC_YAML);
    const r = sddx(clone, "task", "create", "--spec", "spec.yaml", "--workspace", "worktree");
    expect(r.status).toBe(0);
    const id = /created (\S+) /.exec(r.stdout)?.[1] as string;
    const wt = join(clone, ".sddx-worktrees", id);
    expect(existsSync(wt)).toBe(true);
    const res = runHook("tdd-gate", editEvent(wt, join(wt, "src", "api.ts")));
    expect(denyReason(res)).toContain(id);
    // test paths remain writable in the same worktree
    expect(
      isPassThrough(runHook("tdd-gate", editEvent(wt, join(wt, "tests", "api.test.ts")))),
    ).toBe(true);
  });
});

describe("test-first path passes (5.3)", () => {
  test("red → green → verify, phases earned from observed exit codes", () => {
    const { repo, id } = repoWithTask();

    // writing the test is allowed in PLAN
    expect(
      isPassThrough(runHook("tdd-gate", editEvent(repo, join(repo, "tests", "api.test.ts")))),
    ).toBe(true);
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "api.test.ts"), "// failing test placeholder\n");

    // observed failing run → RED
    let res = runHook("record-test", bashEvent(repo, "bun test tests/api.test.ts", 1));
    expect(String(res.output.systemMessage)).toContain("RED");

    // implementation still blocked in RED
    expect(isPassThrough(runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts"))))).toBe(
      false,
    );

    // observed passing run → GREEN, gate lifts
    res = runHook("record-test", bashEvent(repo, "bun test tests/api.test.ts", 0));
    expect(String(res.output.systemMessage)).toContain("GREEN");
    expect(isPassThrough(runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts"))))).toBe(
      true,
    );
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "api.ts"), "export const ok = true;\n");

    // verifier executes the oracle and writes the receipt
    expect(sddx(repo, "task", "phase", id, "VERIFY").status).toBe(0);
    const v = sddx(repo, "verify", id);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("verdict=pass");
    const receipt = JSON.parse(
      readFileSync(join(repo, ".sddx", "receipts", `${id}.json`), "utf8"),
    ) as Receipt;
    expect(receipt.version).toBe(3);
    expect(receipt.allow).toEqual([]);

    // task file shows hook-sourced evidence for both transitions
    const task = JSON.parse(readFileSync(join(repo, ".sddx", "tasks", `${id}.json`), "utf8"));
    expect(task.evidence.red.source).toBe("hook");
    expect(task.evidence.green.source).toBe("hook");
  });
});

describe("allow exemption is audited (5.4)", () => {
  test("allowed file writable pre-GREEN; exemption lands in the receipt", () => {
    const { repo, id } = repoWithTask();
    expect(sddx(repo, "task", "allow", id, "src/migration.sql").status).toBe(0);

    expect(
      isPassThrough(runHook("tdd-gate", editEvent(repo, join(repo, "src", "migration.sql")))),
    ).toBe(true);
    // a non-allowed sibling stays blocked
    expect(isPassThrough(runHook("tdd-gate", editEvent(repo, join(repo, "src", "api.ts"))))).toBe(
      false,
    );

    runHook("record-test", bashEvent(repo, "bun test", 1));
    runHook("record-test", bashEvent(repo, "bun test", 0));
    expect(sddx(repo, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(sddx(repo, "verify", id).status).toBe(0);

    const receipt = JSON.parse(
      readFileSync(join(repo, ".sddx", "receipts", `${id}.json`), "utf8"),
    ) as Receipt;
    expect(receipt.allow).toEqual(["src/migration.sql"]);
  });
});

describe("stop gate (5.5)", () => {
  test("unfinished task blocks stop; loop flag and DONE allow it", () => {
    const { repo, id } = repoWithTask();
    runHook("record-test", bashEvent(repo, "bun test", 1));
    runHook("record-test", bashEvent(repo, "bun test", 0));

    let res = runHook("stop-gate", { hook_event_name: "Stop", cwd: repo });
    expect(res.output.decision).toBe("block");
    expect(String(res.output.reason)).toContain(id);

    res = runHook("stop-gate", { hook_event_name: "Stop", cwd: repo, stop_hook_active: true });
    expect(res.output.decision).toBeUndefined();

    expect(sddx(repo, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(sddx(repo, "verify", id).status).toBe(0);
    res = runHook("stop-gate", { hook_event_name: "Stop", cwd: repo });
    expect(res.output.decision).toBeUndefined();
  });
});

describe("latency budget (5.6)", () => {
  test("gate and session-start round-trips stay inside budget", () => {
    const { repo } = repoWithTask();
    const timings = {
      "tdd-gate": Number.POSITIVE_INFINITY,
      "session-start": Number.POSITIVE_INFINITY,
    };
    for (const sub of ["tdd-gate", "session-start"] as const) {
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        runHook(sub, sub === "tdd-gate" ? editEvent(repo, join(repo, "a.md")) : { cwd: repo });
        timings[sub] = Math.min(timings[sub], performance.now() - started);
      }
    }
    expect(timings["tdd-gate"]).toBeLessThan(100);
    expect(timings["session-start"]).toBeLessThan(200);
  });

  test("session-start surfaces active tasks", () => {
    const { repo, id } = repoWithTask();
    const res = runHook("session-start", { hook_event_name: "SessionStart", cwd: repo });
    const h = res.output.hookSpecificOutput as Record<string, unknown>;
    expect(String(h.additionalContext)).toContain(id);
    expect(String(h.additionalContext)).toContain("PLAN");
  });
});
