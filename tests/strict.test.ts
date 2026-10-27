import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "../src/lib/receipt";
import { fixtureRepo, writeConfig } from "./fixtures";
import { CLI, completeTask, createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";
import { scenario } from "./scenario";

type Decision = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  systemMessage?: string;
};

function hook(name: string, cwd: string, event: Record<string, unknown>): Decision {
  const r = spawnSync("bun", [CLI, "hook", name], {
    cwd,
    input: JSON.stringify({ cwd, ...event }),
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout || "{}") as Decision;
}

const write = (cwd: string, path: string): Decision =>
  hook("tdd-gate", cwd, { tool_name: "Write", tool_input: { file_path: path, content: "x" } });

type Strict = {
  phase: string;
  profile?: string;
  strict?: { phase?: string; runs: Array<{ test_exit: number; source: string }> };
  allow: string[];
};
const state = (cwd: string, id: string) => readTaskState(cwd, id) as unknown as Strict;

/** A repository on the given profile with one task started. */
function startedTask(
  profile: "default" | "strict",
  scope = ["src/rl/**", "T1.done"],
): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  writeConfig(cwd, { interaction_mode: "human", profile });
  createRun(cwd, { tasks: [{ id: "T1", scope }] });
  return { cwd, wt: startTask(cwd, "T1") };
}

describe("the profile setting", () => {
  scenario("strict-profile", "Absent config", () => {
    const cwd = fixtureRepo();
    const r = sddx(cwd, "config", "show", "--output", "json");
    expect(JSON.parse(r.stdout).data.profile).toBe("default");
  });

  scenario("strict-profile", "Invalid value fails closed", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { profile: "strikt" });
    expect(JSON.parse(sddx(cwd, "config", "show", "--output", "json").stdout).data.profile).toBe(
      "strict",
    );
    const v = sddx(cwd, "config", "validate");
    expect(v.status).toBe(1);
    expect(v.stderr).toContain('"profile" must be one of default|strict');
    expect(v.stderr).toContain('"strikt"');
  });
});

describe("default profile", () => {
  scenario("strict-profile", "Implementation write allowed", () => {
    const { wt } = startedTask("default");
    expect(write(wt, "src/rl/bucket.ts")).toEqual({});
  });

  test("the Bash gate and recorder are inert too", () => {
    const { cwd, wt } = startedTask("default");
    expect(
      hook("bash-gate", wt, { tool_name: "Bash", tool_input: { command: "echo x > src/rl/b.ts" } }),
    ).toEqual({});
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    expect(state(cwd, "T1").strict).toBeUndefined();
  });

  test("the gates do not read task state in the default profile", () => {
    const { wt } = startedTask("default");
    writeFileSync(join(wt, ".sddx", "tasks", "T1.json"), "{corrupt");
    expect(write(wt, "src/rl/bucket.ts")).toEqual({});
  });
});

describe("strict profile gates", () => {
  scenario("strict-profile", "Write before a failing test", () => {
    const { wt } = startedTask("strict");
    const d = write(wt, "src/rl/bucket.ts");
    expect(d.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(d.hookSpecificOutput?.permissionDecisionReason).toContain("no recorded failing test");
  });

  scenario("strict-profile", "Test file allowed", () => {
    const { wt } = startedTask("strict");
    expect(write(wt, "tests/rl.test.ts")).toEqual({});
  });

  scenario("strict-profile", "Write after a failing test", () => {
    const { cwd, wt } = startedTask("strict");
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test tests/rl.test.ts" },
      tool_response: { exit_code: 1 },
    });
    expect(state(cwd, "T1").strict?.phase).toBe("RED");
    expect(write(wt, "src/rl/bucket.ts")).toEqual({});
  });

  test("an implementation write outside the scope stays denied after RED", () => {
    const { wt } = startedTask("strict");
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    const d = write(wt, "src/api/server.ts");
    expect(d.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(d.hookSpecificOutput?.permissionDecisionReason).toContain(
      "outside task T1's declared scope",
    );
  });

  scenario("strict-profile", "Recorder captures a failing run", () => {
    const { cwd, wt } = startedTask("strict");
    const out = hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    expect(out.systemMessage).toContain("recorded RED");
    expect(state(cwd, "T1").strict?.runs).toEqual([
      expect.objectContaining({ test_exit: 1, source: "hook" }),
    ]);
  });

  scenario("strict-profile", "Manual RED with a zero exit is refused", () => {
    const { cwd } = startedTask("strict");
    const r = sddx(cwd, "task", "phase", "T1", "RED", "--test-exit", "0");
    expect(r.status).toBe(1);
    expect(state(cwd, "T1").strict?.runs).toEqual([]);
  });

  scenario("strict-profile", "Manual GREEN without a failing run is refused", () => {
    const { cwd } = startedTask("strict");
    const r = sddx(cwd, "task", "phase", "T1", "GREEN", "--test-exit", "0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GREEN requires a recorded failing run");
    expect(state(cwd, "T1").strict).toEqual({ runs: [] });
  });

  test("manual RED then GREEN with real exit codes are recorded", () => {
    const { cwd } = startedTask("strict");
    expect(sddx(cwd, "task", "phase", "T1", "RED", "--test-exit", "1").status).toBe(0);
    expect(sddx(cwd, "task", "phase", "T1", "GREEN", "--test-exit", "1").status).toBe(1);
    expect(sddx(cwd, "task", "phase", "T1", "GREEN", "--test-exit", "0").status).toBe(0);
    expect(state(cwd, "T1").strict?.phase).toBe("GREEN");
  });

  scenario("strict-profile", "Phase command absent in default", () => {
    const { cwd } = startedTask("default");
    const r = sddx(cwd, "task", "phase", "T1", "RED", "--test-exit", "1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("exists only in the strict profile");
  });

  scenario("strict-profile", "Shell write blocked", () => {
    const { wt } = startedTask("strict");
    const d = hook("bash-gate", wt, {
      tool_name: "Bash",
      tool_input: { command: "echo x > src/rl/bucket.ts" },
    });
    expect(d.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("the Bash gate lifts once a failing test is recorded", () => {
    const { wt } = startedTask("strict");
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    expect(
      hook("bash-gate", wt, {
        tool_name: "Bash",
        tool_input: { command: "echo x > src/rl/bucket.ts" },
      }),
    ).toEqual({});
  });
});

describe("allow list", () => {
  scenario("strict-profile", "Allow in default profile", () => {
    const { cwd } = startedTask("default");
    const r = sddx(cwd, "task", "allow", "T1", "src/gen/schema.ts");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("exists only in the strict profile");
  });

  scenario("strict-profile", "Allow recorded", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1", scope: ["T1.done"] }] });
    const wt = startTask(cwd, "T1");
    expect(sddx(cwd, "task", "allow", "T1", "src/gen/schema.ts").status).toBe(0);
    mkdirSync(join(wt, "src", "gen"), { recursive: true });
    writeFileSync(join(wt, "src", "gen", "schema.ts"), "export {};\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass", "--output", "json");
    const receipt = JSON.parse(
      readFileSync(JSON.parse(r.stdout).data.receiptPath, "utf8"),
    ) as Receipt;
    expect(receipt.allow).toEqual(["src/gen/schema.ts"]);
  });

  test("allow is refused in auto mode", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1", scope: ["T1.done"] }], approve: false });
    startTask(cwd, "T1");
    const r = sddx(cwd, "task", "allow", "T1", "src/gen/schema.ts");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refused in auto mode");
  });
});

describe("profile per task and receipts", () => {
  scenario("strict-profile", "Config changed mid-task", () => {
    const { cwd, wt } = startedTask("strict");
    writeConfig(cwd, { interaction_mode: "human", profile: "default" });
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("started under the strict profile but the config now says default");
    expect(state(cwd, "T1").phase).toBe("IN_PROGRESS");
  });

  scenario("strict-profile", "Strict receipt", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    hook("record-test", wt, {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 0 },
    });
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass", "--output", "json");
    const receipt = JSON.parse(
      readFileSync(JSON.parse(r.stdout).data.receiptPath, "utf8"),
    ) as Receipt;
    expect(receipt.profile).toBe("strict");
    expect(receipt.strict_runs?.map((x) => x.test_exit)).toEqual([1, 0]);
  });

  test("a default-profile receipt carries no strict runs", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const receipt = JSON.parse(
      readFileSync(completeTask(cwd, "T1").receiptPath, "utf8"),
    ) as Receipt;
    expect(receipt.profile).toBe("default");
    expect(receipt.strict_runs).toBeUndefined();
  });
});
