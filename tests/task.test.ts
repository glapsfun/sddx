import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../src/lib/spec";
import {
  abandonOrRetry,
  blockedOn,
  createTask,
  dependsOnList,
  failurePolicyOf,
  markShipped,
  type Phase,
  readTask,
  resolveTaskState,
  retryPolicyOf,
  skippedOn,
  taskId,
  transition,
  writeTask,
} from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

const spec = parseSpec(
  "task: Add a Health endpoint!\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n",
).spec!;

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-task-"));
}

describe("taskId", () => {
  test("slugifies and date-prefixes", () => {
    expect(taskId("Add a Health endpoint!", new Date("2026-07-17T00:00:00Z"))).toBe(
      "20260717-add-a-health-endpoint",
    );
  });
});

describe("task state", () => {
  test("create + read roundtrip, starts in PLAN", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
      mode: "branch",
      branch: "sddx/x",
      base_sha: "abc",
    });
    expect(readTask(cwd, t.id).phase).toBe("PLAN");
    expect(() => createTask(cwd, spec, "s", t.workspace)).toThrow(/exists/);
  });

  test("legal path PLAN→RED→GREEN→REFACTOR→VERIFY with evidence", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "abc" });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "REFACTOR");
    t = transition(t, "VERIFY");
    expect(t.phase).toBe("VERIFY");
    expect(t.evidence.red?.test_exit).toBe(1);
    expect(t.evidence.green?.test_exit).toBe(0);
    expect(t.history.map((h) => h.phase)).toEqual(["PLAN", "RED", "GREEN", "REFACTOR", "VERIFY"]);
  });

  test("evidence gates: RED needs failing exit, GREEN needs passing exit", () => {
    let t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "RED", { testExit: 0 })).toThrow(/failing test/);
    expect(() => transition(t, "RED")).toThrow(/failing test/);
    t = transition(t, "RED", { testExit: 1 });
    expect(() => transition(t, "GREEN", { testExit: 2 })).toThrow(/passing test/);
  });

  test("illegal jumps and model-claimed DONE are rejected", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(() => transition(t, "GREEN", { testExit: 0 })).toThrow(/PLAN → GREEN/);
    const v = { ...t, phase: "VERIFY" as const };
    expect(() => transition(v, "DONE")).toThrow(/verifier/);
    expect(transition(v, "DONE", { internal: true }).phase).toBe("DONE");
  });

  test("M1 task files (no workspace.path) still parse; worktree mode records one", () => {
    const cwd = tmpCwd();
    const m1 = createTask(cwd, spec, "s", { mode: "branch", branch: "sddx/x", base_sha: "a" });
    expect(readTask(cwd, m1.id).workspace.path).toBeUndefined();

    const cwd2 = tmpCwd();
    const m2 = createTask(cwd2, spec, "s", {
      mode: "worktree",
      branch: "sddx/y",
      base_sha: "b",
      path: ".sddx-worktrees/y",
    });
    const back = readTask(cwd2, m2.id);
    expect(back.workspace.mode).toBe("worktree");
    expect(back.workspace.path).toBe(".sddx-worktrees/y");
  });

  test("writeTask bumps updated_at", async () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const before = readTask(cwd, t.id).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    writeTask(cwd, t);
    expect(readTask(cwd, t.id).updated_at > before).toBe(true);
  });
});

describe("scope and depends_on", () => {
  const scopedSpec = parseSpec(
    "task: build the api\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\nscope:\n  - src/api/**\n",
  ).spec!;

  test("scope copied from the spec; root omits depends_on", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, scopedSpec, "s", { mode: "none", branch: null, base_sha: "a" });
    const back = readTask(cwd, t.id);
    expect(back.scope).toEqual(["src/api/**"]);
    expect(back.depends_on).toBeUndefined();
  });

  test("depends_on recorded as a list and round-trips when a single parent is given", () => {
    const cwd = tmpCwd();
    const t = createTask(
      cwd,
      scopedSpec,
      "s",
      { mode: "worktree", branch: null, base_sha: "pending:20260721-parent" },
      { dependsOn: "20260721-parent" },
    );
    const back = readTask(cwd, t.id);
    expect(back.depends_on).toEqual(["20260721-parent"]);
    expect(back.workspace.base_sha).toBe("pending:20260721-parent");
    expect(back.workspace.path).toBeUndefined();
  });

  test("depends_on records multiple parents (fan-in)", () => {
    const cwd = tmpCwd();
    const t = createTask(
      cwd,
      scopedSpec,
      "s",
      { mode: "worktree", branch: null, base_sha: "pending:a,b" },
      { dependsOn: ["20260721-a", "20260721-b"] },
    );
    const back = readTask(cwd, t.id);
    expect(back.depends_on).toEqual(["20260721-a", "20260721-b"]);
  });

  test("legacy single-string depends_on on disk reads as a one-element list", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, scopedSpec, "s", { mode: "none", branch: null, base_sha: "a" });
    // simulate a pre-DAG task file written with the old scalar shape
    const legacy = { ...readTask(cwd, t.id), depends_on: "20260721-parent" };
    writeTask(cwd, legacy as never);
    expect(dependsOnList(readTask(cwd, t.id))).toEqual(["20260721-parent"]);
  });

  test("attempt_count defaults to 1 and on_dependency_failure/retry default via helpers", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, scopedSpec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(t.attempt_count).toBe(1);
    expect(failurePolicyOf(t)).toBe("skip");
    expect(retryPolicyOf(t)).toEqual({ max_attempts: 1, workspace: "fresh" });
  });

  test("on_dependency_failure and retry are copied from the spec", () => {
    const specWithPolicy = parseSpec(
      "task: build the api\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\non_dependency_failure: block\nretry:\n  max_attempts: 3\n  workspace: reuse\n",
    ).spec!;
    const cwd = tmpCwd();
    const t = createTask(cwd, specWithPolicy, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(t.on_dependency_failure).toBe("block");
    expect(retryPolicyOf(t)).toEqual({ max_attempts: 3, workspace: "reuse" });
  });
});

describe("blockedOn / skippedOn", () => {
  function makeTask(cwd: string, sentence: string, dependsOn?: string | string[]) {
    const s = parseSpec(
      `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n`,
    ).spec!;
    return createTask(
      cwd,
      s,
      "s",
      { mode: "none", branch: null, base_sha: "a" },
      dependsOn ? { dependsOn } : {},
    );
  }

  test("blocked until every named parent is DONE", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "parent a");
    const b = makeTask(cwd, "parent b");
    const d = makeTask(cwd, "child d", [a.id, b.id]);
    expect(blockedOn(cwd, d)).toBe(a.id);

    const aDone = { ...readTask(cwd, a.id), phase: "DONE" as const };
    writeTask(cwd, aDone);
    // A is DONE, B is not — blocked-on-B specifically, not A
    expect(blockedOn(cwd, d)).toBe(b.id);

    const bDone = { ...readTask(cwd, b.id), phase: "DONE" as const };
    writeTask(cwd, bDone);
    expect(blockedOn(cwd, d)).toBeNull();
  });

  test("block-policy dependent stays blocked when its parent is ABANDONED", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "parent a");
    const bSpec = parseSpec(
      "task: block child\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\non_dependency_failure: block\n",
    ).spec!;
    const b = createTask(
      cwd,
      bSpec,
      "s",
      { mode: "none", branch: null, base_sha: "a" },
      {
        dependsOn: a.id,
      },
    );
    writeTask(cwd, { ...readTask(cwd, a.id), phase: "ABANDONED" as const });
    expect(blockedOn(cwd, b)).toBe(a.id);
    expect(skippedOn(cwd, b)).toBeNull();
  });

  test("skip-policy (default) dependent is skipped when its parent is ABANDONED", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "parent a");
    const b = makeTask(cwd, "child b", a.id);
    writeTask(cwd, { ...readTask(cwd, a.id), phase: "ABANDONED" as const });
    expect(skippedOn(cwd, b)).toBe(a.id);
  });

  test("fan-in child skips if any one of several parents is ABANDONED, even if others are DONE", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "parent a");
    const b = makeTask(cwd, "parent b");
    const d = makeTask(cwd, "child d", [a.id, b.id]);
    writeTask(cwd, { ...readTask(cwd, a.id), phase: "DONE" as const });
    writeTask(cwd, { ...readTask(cwd, b.id), phase: "ABANDONED" as const });
    expect(skippedOn(cwd, d)).toBe(b.id);
  });

  test("skip cascades transitively through a chain of skip-policy tasks", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "root a");
    const s1 = makeTask(cwd, "mid s1", a.id);
    const s2 = makeTask(cwd, "leaf s2", s1.id);
    writeTask(cwd, { ...readTask(cwd, a.id), phase: "ABANDONED" as const });
    expect(skippedOn(cwd, s1)).toBe(a.id);
    expect(skippedOn(cwd, s2)).toBe(s1.id);
  });

  test("an unrelated sibling with no shared edge is unaffected", () => {
    const cwd = tmpCwd();
    const a = makeTask(cwd, "root a");
    makeTask(cwd, "dependent b", a.id);
    const r = makeTask(cwd, "unrelated root r");
    writeTask(cwd, { ...readTask(cwd, a.id), phase: "ABANDONED" as const });
    expect(blockedOn(cwd, r)).toBeNull();
    expect(skippedOn(cwd, r)).toBeNull();
  });
});

describe("abandonOrRetry", () => {
  test("default policy (max_attempts 1) abandons immediately", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const outcome = abandonOrRetry(t);
    expect(outcome).toEqual({ retried: false, attempt_count: 1, max_attempts: 1 });
    expect(t.phase).toBe("ABANDONED");
  });

  test("retries twice before reaching ABANDONED on the third exhaustion", () => {
    const retrySpec = parseSpec(
      "task: flaky\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\nretry:\n  max_attempts: 3\n",
    ).spec!;
    const t = createTask(tmpCwd(), retrySpec, "s", { mode: "none", branch: null, base_sha: "a" });
    t.phase = "GREEN" as Phase;

    const first = abandonOrRetry(t);
    expect(first).toEqual({ retried: true, attempt_count: 2, max_attempts: 3 });
    expect(t.phase).toBe("PLAN");

    t.phase = "GREEN" as Phase;
    const second = abandonOrRetry(t);
    expect(second).toEqual({ retried: true, attempt_count: 3, max_attempts: 3 });
    expect(t.phase).toBe("PLAN");

    t.phase = "GREEN" as Phase;
    const third = abandonOrRetry(t);
    expect(third).toEqual({ retried: false, attempt_count: 3, max_attempts: 3 });
    expect(t.phase).toBe("ABANDONED");
  });

  test("a retry clears iterations, evidence, and stuck; appends a PLAN history entry", () => {
    const retrySpec = parseSpec(
      "task: flaky\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\nretry:\n  max_attempts: 2\n",
    ).spec!;
    const t = createTask(tmpCwd(), retrySpec, "s", { mode: "none", branch: null, base_sha: "a" });
    t.phase = "GREEN" as Phase;
    t.iterations = 4;
    t.evidence.red = { test_exit: 1, at: new Date().toISOString() };
    t.stuck = { fingerprint: "x", count: 3, since: new Date().toISOString() };
    abandonOrRetry(t);
    expect(t.iterations).toBe(0);
    expect(t.evidence).toEqual({});
    expect(t.stuck).toBeUndefined();
    expect(t.history.at(-1)?.phase).toBe("PLAN");
  });

  test("refuses on an already-terminal task", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    t.phase = "DONE";
    expect(() => abandonOrRetry(t)).toThrow(/illegal transition/);
  });
});

describe("markShipped", () => {
  test("records goal id, PR url, and a timestamp", () => {
    const t = createTask(tmpCwd(), spec, "s", { mode: "none", branch: null, base_sha: "a" });
    markShipped(t, "20260719-ship-goal", "https://github.com/org/repo/pull/1");
    expect(t.shipped?.goal_id).toBe("20260719-ship-goal");
    expect(t.shipped?.pr_url).toBe("https://github.com/org/repo/pull/1");
    expect(t.shipped?.at).toBeTruthy();
  });
});

describe("resolveTaskState", () => {
  test("finds a task in the main checkout (branch/none mode)", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    expect(resolveTaskState(cwd, t.id)?.id).toBe(t.id);
  });

  test("finds a task in a live worktree directory before the main checkout", () => {
    const cwd = tmpCwd();
    const t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const wtTasksDir = join(cwd, ".sddx-worktrees", t.id, ".sddx", "tasks");
    mkdirSync(wtTasksDir, { recursive: true });
    writeFileSync(
      join(wtTasksDir, `${t.id}.json`),
      JSON.stringify({ ...t, phase: "GREEN" }, null, 2),
    );
    // worktree copy wins — it's the live one
    expect(resolveTaskState(cwd, t.id)?.phase).toBe("GREEN");
  });

  test("falls back to the tip of the task's own branch once no live copy exists", () => {
    const repo = fixtureRepo();
    const g = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    const t = createTask(repo, spec, "s", { mode: "none", branch: "sddx/x", base_sha: "a" });
    g("switch", "-c", `sddx/${t.id}`);
    g("add", "-A");
    g("commit", "-qm", "task commit");
    g("switch", "main");
    // no task file at all on main or in any worktree dir — only on the branch
    expect(resolveTaskState(repo, t.id)?.id).toBe(t.id);
  });

  test("returns null when the task doesn't exist anywhere", () => {
    expect(resolveTaskState(tmpCwd(), "no-such-task")).toBeNull();
  });
});
