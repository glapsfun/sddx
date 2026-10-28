import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifySignature } from "../src/lib/sign";
import { fixtureRepo, signingRepo, writeConfig } from "./fixtures";
import {
  CLI,
  commitSpec,
  completeTask,
  createRun,
  goalIds,
  goalSpec,
  readGoalAnywhere,
  sddx,
  userEnv,
  writeSpec,
} from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

/** Everything a plan could create: branches, refs, worktrees, and the working tree. */
function snapshot(cwd: string): string {
  return [
    git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    git(cwd, "status", "--porcelain", "--untracked-files=all"),
    existsSync(join(cwd, ".sddx-worktrees")) ? "worktrees" : "no-worktrees",
  ].join("\n");
}

function nothingStarted(cwd: string): void {
  expect(goalIds(cwd)).toEqual([]);
  expect(git(cwd, "branch", "--list", "sddx/*")).toBe("");
  expect(existsSync(join(cwd, ".sddx-worktrees"))).toBe(false);
  expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
}

const SPEC = "2026-01-01-test-goal";
const twoTasks = () =>
  goalSpec({
    tasks: [
      { id: "a-1", scope: ["src/a/**"] },
      { id: "b-1", scope: ["src/b/**"] },
    ],
  });

function hook(cwd: string, event: Record<string, unknown>) {
  const r = spawnSync("bun", [CLI, "hook", "approval-gate"], {
    cwd,
    input: JSON.stringify({ cwd, ...event }),
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout || "{}") as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
}

describe("plan check", () => {
  scenario("plan-approval", "Valid plan renders", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const before = snapshot(cwd);
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/plan [0-9a-f]{64}/);
    expect(r.stdout).toContain(`base ${git(cwd, "rev-parse", "HEAD")}`);
    expect(r.stdout).toContain("2 task(s)");
    expect(snapshot(cwd)).toBe(before);
  });

  scenario("plan-approval", "Open decisions block planning", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({ tasks: [{ id: "a-1" }], openDecisions: ["which store backs counters"] }),
    );
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("which store backs counters");
  });

  scenario("plan-approval", "Overlapping concurrent scopes", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({
        tasks: [
          { id: "a-1", scope: ["src/api/**"] },
          { id: "b-1", scope: ["src/api/**"] },
        ],
      }),
    );
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('scope overlap between concurrent tasks "a-1" and "b-1"');
  });

  scenario("plan-approval", "Dependency cycle", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({
        tasks: [
          { id: "T1", dependsOn: ["T2"] },
          { id: "T2", dependsOn: ["T1"] },
        ],
      }),
    );
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dependency cycle");
  });

  scenario("plan-approval", "Unknown dependency", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({ tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T9"] }] }),
    );
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("task T2 depends on unknown task T9");
  });

  scenario("plan-approval", "Reused task id", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "receipts"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "receipts", "T1.json"), "{}\n");
    const spec = writeSpec(cwd, SPEC, goalSpec({ tasks: [{ id: "T1" }] }));
    const r = sddx(cwd, "plan", "check", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("task id T1 is already used by .sddx/receipts/T1.json");
  });

  test("a spec outside .sddx/specs or with a nonconforming name is refused", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "goal.md"), goalSpec({ tasks: [{ id: "T1" }] }));
    expect(sddx(cwd, "plan", "check", "goal.md").stderr).toContain(
      "must live directly in .sddx/specs/",
    );
    const bad = writeSpec(cwd, "rate-limit", goalSpec({ tasks: [{ id: "T1" }] }));
    expect(sddx(cwd, "plan", "check", bad).stderr).toContain("<YYYY-MM-DD>-<slug>.md");
  });
});

describe("committed specs", () => {
  scenario("plan-approval", "Uncommitted spec", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "specs"), { recursive: true });
    const spec = ".sddx/specs/2026-10-26-x.md";
    writeFileSync(join(cwd, spec), twoTasks());
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${spec} is not committed; commit it first`);
    expect(r.stderr).toContain(`git add ${spec} && git commit`);
    nothingStarted(cwd);
    // staged but not committed is still not committed
    git(cwd, "add", spec);
    expect(sddx(cwd, "plan", "check", spec).status).toBe(1);
  });

  scenario("plan-approval", "Run branch merges cleanly", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    const merge = spawnSync("git", ["merge", "--no-ff", "-m", "merge run", run.runBranch], {
      cwd,
      encoding: "utf8",
    });
    expect(merge.status).toBe(0);
    expect(existsSync(join(cwd, ".sddx", "receipts", "T1.json"))).toBe(true);
  });
});

describe("plan approval", () => {
  scenario("plan-approval", "Prose edit changes the hash", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const hashOf = () =>
      JSON.parse(sddx(cwd, "plan", "check", spec, "--output", "json").stdout).data
        .planSha256 as string;
    const h = hashOf();
    const path = join(cwd, spec);
    writeFileSync(path, readFileSync(path, "utf8").replace("Exercise sddx.", "Exercise sddx now."));
    expect(hashOf()).not.toBe(h);
  });

  scenario("plan-approval", "Approve a valid plan", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = sddx(cwd, "plan", "approve", spec, "--output", "json");
    expect(r.status).toBe(0);
    const hash = JSON.parse(r.stdout).data.planSha256 as string;
    const token = JSON.parse(readFileSync(join(cwd, ".sddx", "approvals", `${hash}.json`), "utf8"));
    expect(token.plan_sha256).toBe(hash);
    expect(token.mode).toBe("human");
    expect(token.signature).toBeUndefined();
  });

  scenario("plan-approval", "Approval from an agent's tool call", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = spawnSync("bun", [CLI, "plan", "approve", spec], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CODEX_TOOL_CALL_ID: "call_1" },
    });
    expect(r.status).toBe(3);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);
    expect(`${r.stdout}${r.stderr}`).toContain(`sddx plan approve ${spec}`);
    expect(`${r.stdout}${r.stderr}`).toContain("!");
  });

  scenario("plan-approval", "Approval typed by the user", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const env = userEnv({ NO_COLOR: "1" });
    const r = spawnSync("bun", [CLI, "plan", "approve", spec], { cwd, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(true);
  });

  test("the command to type quotes a spec path holding a space", () => {
    const r = spawnSync("bun", [CLI, "plan", "approve", ".sddx/specs/my plan.md"], {
      cwd: fixtureRepo(),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CODEX_TOOL_CALL_ID: "call_1" },
    });
    expect(r.status).toBe(3);
    expect(`${r.stdout}${r.stderr}`).toContain("plan approve '.sddx/specs/my plan.md'");
  });

  test("an empty CODEX_TOOL_CALL_ID does not count as a tool call", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = spawnSync("bun", [CLI, "plan", "approve", spec], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CODEX_TOOL_CALL_ID: "" },
    });
    expect(r.status).toBe(0);
  });

  scenario("plan-approval", "Approve refuses an invalid plan", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({ tasks: [{ id: "T1" }], openDecisions: ["undecided"] }),
    );
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(1);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);
  });

  scenario("plan-approval", "Signed approval", () => {
    const cwd = signingRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = sddx(cwd, "plan", "approve", spec, "--output", "json");
    expect(r.status).toBe(0);
    const hash = JSON.parse(r.stdout).data.planSha256 as string;
    const token = JSON.parse(readFileSync(join(cwd, ".sddx", "approvals", `${hash}.json`), "utf8"));
    expect(token.signature).toContain("BEGIN SSH SIGNATURE");
    expect(
      verifySignature(
        cwd,
        hash,
        { signature: token.signature, signer: token.signer },
        "sddx-approval",
      ),
    ).toBe("valid");
  });

  test("the reported harness is recorded on the token", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = sddx(cwd, "plan", "approve", spec, "--harness", "codex", "--output", "json");
    const hash = JSON.parse(r.stdout).data.planSha256 as string;
    const token = JSON.parse(readFileSync(join(cwd, ".sddx", "approvals", `${hash}.json`), "utf8"));
    expect(token.harness_reported).toBe("codex");
  });
});

describe("plan start gate", () => {
  scenario("plan-approval", "Start without approval", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/no approval on file for plan [0-9a-f]{64}/);
    expect(r.stderr).toContain(`sddx plan approve ${spec}`);
    nothingStarted(cwd);
  });

  scenario("plan-approval", "Edit after approval", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(0);
    writeFileSync(join(cwd, spec), `${readFileSync(join(cwd, spec), "utf8")} `);
    commitSpec(cwd, spec);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(3);
    nothingStarted(cwd);
  });

  scenario("plan-approval", "Protected scope refuses", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto" });
    const spec = writeSpec(
      cwd,
      SPEC,
      goalSpec({ tasks: [{ id: "T1", scope: ["services/auth/**"] }] }),
    );
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('protected area "auth"');
    expect(goalIds(cwd)).toEqual([]);
  });

  scenario("plan-approval", "Too many tasks", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 6 });
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `T${i + 1}`,
      scope: [`src/t${i}/**`],
    }));
    const spec = writeSpec(cwd, SPEC, goalSpec({ tasks }));
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("auto_max_tasks ceiling of 6");
    expect(goalIds(cwd)).toEqual([]);
  });

  scenario("plan-approval", "Bounds pass", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto" });
    const spec = writeSpec(cwd, SPEC, goalSpec({ tasks: [{ id: "T1", scope: ["src/x/**"] }] }));
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(0);
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);
    const goal = readGoalAnywhere(cwd, SPEC) as {
      approval: { mode: string; authorization: string };
    };
    expect(goal.approval.mode).toBe("auto");
    expect(goal.approval.authorization).toBe("auto");
  });

  scenario("plan-approval", "Environment cannot switch mode", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human" });
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const r = spawnSync("bun", [CLI, "plan", "start", spec], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SDDX_INTERACTION_MODE: "auto" },
    });
    expect(r.status).toBe(3);
  });

  scenario("plan-approval", "Invalid value falls back to human", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "autonomous" });
    const spec = writeSpec(cwd, SPEC, twoTasks());
    expect(sddx(cwd, "plan", "start", spec).status).toBe(3);
    const cfg = JSON.parse(sddx(cwd, "config", "show", "--output", "json").stdout).data;
    expect(cfg.interaction_mode).toBe("human");
  });
});

describe("plan start", () => {
  scenario("plan-approval", "Successful start", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(0);
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(0);
    expect(goalIds(cwd)).toEqual([SPEC]);
    expect(git(cwd, "branch", "--list", `sddx/run-${SPEC}`)).toContain(`sddx/run-${SPEC}`);
    for (const id of ["a-1", "b-1"]) {
      const t = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${id}.json`), "utf8"));
      expect(t.phase).toBe("PLANNED");
      expect(t.goal_id).toBe(SPEC);
    }
    const cfg = JSON.parse(readFileSync(join(cwd, ".sddx", "config.json"), "utf8"));
    expect(cfg).toEqual({ schema_version: "2.0", interaction_mode: "human", profile: "default" });
  });

  test("the run branch starts with a commit carrying the approved spec bytes", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    sddx(cwd, "plan", "approve", spec);
    sddx(cwd, "plan", "start", spec);
    const committed = spawnSync("git", ["show", `sddx/run-${SPEC}:${spec}`], { cwd }).stdout;
    expect(committed.equals(readFileSync(join(cwd, spec)))).toBe(true);
    expect(git(cwd, "rev-parse", `sddx/run-${SPEC}~1`)).toBe(git(cwd, "rev-parse", "HEAD"));
  });

  scenario("plan-approval", "Failed start rolls back the goal record", () => {
    if (process.getuid?.() === 0) return;
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    sddx(cwd, "plan", "approve", spec);
    mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
    chmodSync(join(cwd, ".sddx"), 0o555);
    let failed: ReturnType<typeof sddx>;
    try {
      failed = sddx(cwd, "plan", "start", spec);
    } finally {
      chmodSync(join(cwd, ".sddx"), 0o755);
    }
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("rolled back");
    expect(git(cwd, "for-each-ref", "refs/sddx/goals")).toBe("");
    expect(git(cwd, "branch", "--list", `sddx/run-${SPEC}`)).toBe("");
    expect(existsSync(join(cwd, ".sddx", "tasks", "a-1.json"))).toBe(false);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(0);
  });

  scenario("plan-approval", "Start is not repeatable", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    sddx(cwd, "plan", "approve", spec);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(0);
    const refs = git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");
    const again = sddx(cwd, "plan", "start", spec);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`goal ${SPEC} already exists`);
    expect(git(cwd, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
  });

  scenario("plan-approval", "Submodule overlap", () => {
    const cwd = fixtureRepo();
    writeFileSync(
      join(cwd, ".gitmodules"),
      '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ../lib\n',
    );
    git(cwd, "add", ".gitmodules");
    git(cwd, "commit", "-qm", "submodule");
    const spec = writeSpec(cwd, SPEC, goalSpec({ tasks: [{ id: "T1", scope: ["vendor/**"] }] }));
    sddx(cwd, "plan", "approve", spec);
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("submodule vendor/lib");
    expect(goalIds(cwd)).toEqual([]);
  });
});

describe("approval gate hook", () => {
  scenario("plan-approval", "Approve command raises a dialog", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    const out = hook(cwd, {
      tool_name: "Bash",
      tool_input: { command: `sddx plan approve ${spec}` },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("records YOUR approval");
  });

  scenario("plan-approval", "Forged token write denied", () => {
    const cwd = fixtureRepo();
    const out = hook(cwd, {
      tool_name: "Write",
      tool_input: { file_path: ".sddx/approvals/abc.json", content: "{}" },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("a write to verify's proof records is denied, by file tool or shell; a read is not", () => {
    const cwd = fixtureRepo();
    const decision = (event: Record<string, unknown>) =>
      hook(cwd, event).hookSpecificOutput?.permissionDecision;
    expect(
      decision({
        tool_name: "Write",
        tool_input: { file_path: join(cwd, ".git", "sddx-proofs", "T1.json"), content: "{}" },
      }),
    ).toBe("deny");
    expect(
      decision({
        tool_name: "Bash",
        tool_input: { command: "echo '{}' > .git/sddx-proofs/T1.json" },
      }),
    ).toBe("deny");
    expect(
      decision({ tool_name: "Bash", tool_input: { command: "cat .git/sddx-proofs/T1.json" } }),
    ).toBeUndefined();
  });

  scenario("plan-approval", "Internal error fails closed", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), "{not json");
    const out = hook(cwd, {
      tool_name: "Bash",
      tool_input: { command: `sddx plan start ${spec}` },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  test("an approved plan's start passes, and unrelated commands pass", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, SPEC, twoTasks());
    sddx(cwd, "plan", "approve", spec);
    expect(
      hook(cwd, { tool_name: "Bash", tool_input: { command: `sddx plan start ${spec}` } }),
    ).toEqual({});
    expect(
      hook(cwd, { tool_name: "Bash", tool_input: { command: "terraform plan start" } }),
    ).toEqual({});
    expect(hook(cwd, { tool_name: "Bash", tool_input: { command: "bun test" } })).toEqual({});
  });

  test("a shell write to the config is denied, a read is not", () => {
    const cwd = fixtureRepo();
    const write = hook(cwd, {
      tool_name: "Bash",
      tool_input: { command: "echo '{}' > .sddx/config.json" },
    });
    expect(write.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(
      hook(cwd, { tool_name: "Bash", tool_input: { command: "cat .sddx/config.json" } }),
    ).toEqual({});
  });
});
