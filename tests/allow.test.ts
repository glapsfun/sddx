import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { allowPath, createTask, readTask, transition, writeTask } from "../src/lib/task";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const SPEC = {
  task: "allow demo",
  context: [],
  success_criteria: ["x"],
  oracle: { type: "command" as const, run: "true", expect: "exit 0" },
  stop_rules: [],
  out_of_scope: [],
};

const makeTask = (repo: string) =>
  createTask(repo, SPEC, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: "0".repeat(40),
  });

describe("allowPath", () => {
  test("appends normalized path, idempotent", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    allowPath(t, "./src/migration.sql");
    allowPath(t, "src/migration.sql");
    expect(t.allow).toEqual(["src/migration.sql"]);
  });

  test("refuses absolute and escaping paths", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    expect(() => allowPath(t, "/etc/passwd")).toThrow("repo-relative");
    expect(() => allowPath(t, "../outside.ts")).toThrow("repo-relative");
  });

  test("refuses terminal tasks", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    transition(t, "ABANDONED");
    expect(() => allowPath(t, "src/a.ts")).toThrow("frozen");
  });
});

describe("sddx task allow (CLI)", () => {
  test("persists to the task file and updates updated_at", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    const before = readTask(repo, t.id).updated_at;
    const r = spawnSync(
      "bun",
      [join(repoRoot, "src", "cli.ts"), "task", "allow", t.id, "src/schema.sql"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("allow=[src/schema.sql]");
    const after = readTask(repo, t.id);
    expect(after.allow).toEqual(["src/schema.sql"]);
    expect(after.updated_at >= before).toBe(true);
  });

  test("fails loudly on a DONE task", () => {
    const repo = fixtureRepo();
    const t = makeTask(repo);
    t.phase = "DONE"; // direct write: PLAN→DONE is not a legal transition to walk
    writeTask(repo, t);
    const r = spawnSync(
      "bun",
      [join(repoRoot, "src", "cli.ts"), "task", "allow", t.id, "src/schema.sql"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("frozen");
  });
});
