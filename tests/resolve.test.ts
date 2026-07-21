import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headBranch, resolveTask, workspaceRoot } from "../src/lib/resolve";
import { createTask, readTask, transition, writeTask } from "../src/lib/task";
import { fixtureClone, fixtureRepo } from "./fixtures";

const SPEC = {
  task: "demo task",
  context: [],
  success_criteria: ["x"],
  oracle: { type: "command" as const, run: "true", expect: "exit 0" },
  stop_rules: [],
  out_of_scope: [],
  scope: [],
};

function makeTask(repo: string, sentence = "demo task"): string {
  const t = createTask(repo, { ...SPEC, task: sentence }, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: "0".repeat(40),
  });
  return t.id;
}

describe("workspaceRoot", () => {
  test("finds repo root from nested nonexistent file path", () => {
    const repo = fixtureRepo();
    expect(workspaceRoot(join(repo, "src", "deep", "new.ts"))).toBe(repo);
  });

  test("null outside any repo", () => {
    expect(workspaceRoot("/no/such/path/anywhere")).toBeNull();
  });
});

describe("resolveTask", () => {
  test("none when repo has no .sddx", () => {
    const repo = fixtureRepo();
    expect(resolveTask(join(repo, "src", "a.ts")).kind).toBe("none");
  });

  test("sole non-terminal task in main checkout", () => {
    const repo = fixtureRepo();
    const id = makeTask(repo);
    const res = resolveTask(join(repo, "src", "a.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") {
      expect(res.task.id).toBe(id);
      expect(res.root).toBe(repo);
    }
  });

  test("terminal tasks are not candidates", () => {
    const repo = fixtureRepo();
    const id = makeTask(repo);
    const t = readTask(repo, id);
    transition(t, "ABANDONED");
    writeTask(repo, t);
    expect(resolveTask(join(repo, "a.ts")).kind).toBe("none");
  });

  test("two non-terminal tasks → ambiguous with both ids", () => {
    const repo = fixtureRepo();
    const a = makeTask(repo, "first thing");
    const b = makeTask(repo, "second thing");
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.ids.sort()).toEqual([a, b].sort());
  });

  test("corrupt task file reported", () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, ".sddx", "tasks"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "tasks", "20260101-bad.json"), "{nope");
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("corrupt");
    if (res.kind === "corrupt") expect(res.path).toContain("20260101-bad.json");
  });

  test("worktree resolves by directory name, reading the worktree's own .sddx", () => {
    const { clone } = fixtureClone();
    const wt = join(clone, ".sddx-worktrees", "20260101-wt-task");
    spawnSync("git", ["worktree", "add", "-q", wt, "-b", "sddx/20260101-wt-task"], { cwd: clone });
    mkdirSync(join(wt, ".sddx", "tasks"), { recursive: true });
    const state = {
      id: "20260101-wt-task",
      task: "wt",
      phase: "RED",
      spec_path: "x",
      oracle: SPEC.oracle,
      workspace: { mode: "worktree", branch: "sddx/20260101-wt-task", base_sha: "0".repeat(40) },
      allow: [],
      iterations: 0,
      evidence: {},
      history: [],
      created_at: "",
      updated_at: "",
    };
    writeFileSync(
      join(wt, ".sddx", "tasks", "20260101-wt-task.json"),
      JSON.stringify(state, null, 2),
    );
    const res = resolveTask(join(wt, "src", "impl.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") {
      expect(res.task.id).toBe("20260101-wt-task");
      expect(res.root).toBe(wt);
    }
  });

  test("branch checkout resolves via sddx/<id> HEAD ref", () => {
    const repo = fixtureRepo();
    const id = makeTask(repo);
    // second task would make the scan ambiguous — branch must disambiguate
    makeTask(repo, "other thing");
    spawnSync("git", ["switch", "-qc", `sddx/${id}`], { cwd: repo });
    expect(headBranch(repo)).toBe(`sddx/${id}`);
    const res = resolveTask(join(repo, "a.ts"));
    expect(res.kind).toBe("task");
    if (res.kind === "task") expect(res.task.id).toBe(id);
  });
});
