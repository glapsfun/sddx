import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, readTask, type TaskState, transition, writeTask } from "../src/lib/task";
import { blockMessage, tddGate } from "../src/tdd-gate";
import { fixtureRepo } from "./fixtures";

const SPEC = {
  task: "gate demo",
  context: [],
  success_criteria: ["x"],
  oracle: { type: "command" as const, run: "true", expect: "exit 0" },
  stop_rules: [],
  out_of_scope: [],
  scope: [],
};

function redTask(repo: string): TaskState {
  const t = createTask(repo, SPEC, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: "0".repeat(40),
  });
  transition(t, "RED", { testExit: 1 });
  writeTask(repo, t);
  return t;
}

describe("tddGate", () => {
  test("denies implementation write in RED", () => {
    const repo = fixtureRepo();
    redTask(repo);
    const d = tddGate({ filePath: join(repo, "src", "api.ts") });
    expect(d.allow).toBe(false);
  });

  test("denies implementation-first write in PLAN", () => {
    const repo = fixtureRepo();
    createTask(repo, SPEC, ".sddx/specs/x.yaml", {
      mode: "none",
      branch: null,
      base_sha: "0".repeat(40),
    });
    const d = tddGate({ filePath: join(repo, "src", "api.ts") });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("PLAN");
  });

  test("allows test write in RED", () => {
    const repo = fixtureRepo();
    redTask(repo);
    expect(tddGate({ filePath: join(repo, "tests", "api.test.ts") }).allow).toBe(true);
  });

  test("allows exempt write in RED", () => {
    const repo = fixtureRepo();
    redTask(repo);
    expect(tddGate({ filePath: join(repo, "README.md") }).allow).toBe(true);
  });

  test("allow-listed file writable in RED", () => {
    const repo = fixtureRepo();
    const t = redTask(repo);
    t.allow.push("src/migration.sql");
    writeTask(repo, t);
    expect(tddGate({ filePath: join(repo, "src", "migration.sql") }).allow).toBe(true);
  });

  test("inert outside sddx repos and in non-RED phases", () => {
    const bare = fixtureRepo();
    expect(tddGate({ filePath: join(bare, "src", "api.ts") }).allow).toBe(true);

    const repo = fixtureRepo();
    const t = redTask(repo);
    transition(t, "GREEN", { testExit: 0 });
    writeTask(repo, t);
    expect(tddGate({ filePath: join(repo, "src", "api.ts") }).allow).toBe(true);
  });

  test("cwd-relative file paths are anchored to cwd", () => {
    const repo = fixtureRepo();
    redTask(repo);
    expect(tddGate({ filePath: "src/api.ts", cwd: repo }).allow).toBe(false);
    expect(tddGate({ filePath: "tests/api.test.ts", cwd: repo }).allow).toBe(true);
  });

  test("userConfig test_globs honored via config input", () => {
    const repo = fixtureRepo();
    redTask(repo);
    const d = tddGate({
      filePath: join(repo, "checks", "health.ts"),
      config: { testGlobs: "checks/**" },
    });
    expect(d.allow).toBe(true);
  });

  test("config file .sddx/config.json is read", () => {
    const repo = fixtureRepo();
    redTask(repo);
    writeFileSync(join(repo, ".sddx", "config.json"), JSON.stringify({ test_globs: "qa/**" }));
    expect(tddGate({ filePath: join(repo, "qa", "smoke.ts") }, {}).allow).toBe(true);
  });

  test("ambiguous governing task denies, naming candidates", () => {
    const repo = fixtureRepo();
    redTask(repo);
    const other = createTask(repo, { ...SPEC, task: "second thing" }, ".sddx/specs/y.yaml", {
      mode: "none",
      branch: null,
      base_sha: "0".repeat(40),
    });
    const d = tddGate({ filePath: join(repo, "src", "api.ts") });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain(other.id);
  });

  test("corrupt task file denies", () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, ".sddx", "tasks"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "tasks", "20260101-bad.json"), "{broken");
    const d = tddGate({ filePath: join(repo, "src", "api.ts") });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("20260101-bad.json");
  });
});

describe("scope confinement", () => {
  const SCOPED = { ...SPEC, task: "scoped work", scope: ["src/db/**"] };

  function scopedGreenTask(repo: string): TaskState {
    const t = createTask(repo, SCOPED, ".sddx/specs/x.yaml", {
      mode: "none",
      branch: null,
      base_sha: "0".repeat(40),
    });
    transition(t, "RED", { testExit: 1 });
    transition(t, "GREEN", { testExit: 0 });
    writeTask(repo, t);
    return t;
  }

  test("in-scope implementation write allowed in GREEN", () => {
    const repo = fixtureRepo();
    scopedGreenTask(repo);
    expect(tddGate({ filePath: join(repo, "src", "db", "schema.ts") }).allow).toBe(true);
  });

  test("out-of-scope implementation write blocked, naming path and scope", () => {
    const repo = fixtureRepo();
    const t = scopedGreenTask(repo);
    const d = tddGate({ filePath: join(repo, "src", "api", "users.ts") });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("src/api/users.ts");
      expect(d.reason).toContain("src/db/**");
      expect(d.reason).toContain(t.id);
    }
  });

  test("exempt path allowed despite being out of scope", () => {
    const repo = fixtureRepo();
    scopedGreenTask(repo);
    expect(tddGate({ filePath: join(repo, "README.md") }).allow).toBe(true);
  });

  test("allow-listed out-of-scope path permitted", () => {
    const repo = fixtureRepo();
    const t = scopedGreenTask(repo);
    t.allow.push("src/api/users.ts");
    writeTask(repo, t);
    expect(tddGate({ filePath: join(repo, "src", "api", "users.ts") }).allow).toBe(true);
  });

  test("no declared scope means no confinement", () => {
    const repo = fixtureRepo();
    const t = createTask(repo, SPEC, ".sddx/specs/x.yaml", {
      mode: "none",
      branch: null,
      base_sha: "0".repeat(40),
    });
    transition(t, "RED", { testExit: 1 });
    transition(t, "GREEN", { testExit: 0 });
    writeTask(repo, t);
    expect(tddGate({ filePath: join(repo, "anywhere", "file.ts") }).allow).toBe(true);
  });
});

describe("blockMessage", () => {
  test("names path, task, phase, and both remedies", () => {
    const repo = fixtureRepo();
    const t = redTask(repo);
    const msg = blockMessage(t, "src/api.ts", {});
    expect(msg).toContain("src/api.ts");
    expect(msg).toContain(t.id);
    expect(msg).toContain("RED");
    expect(msg).toContain("failing test");
    expect(msg).toContain(`sddx task allow ${t.id} src/api.ts`);
    expect(readTask(repo, t.id).phase).toBe("RED");
  });
});
