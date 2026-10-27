import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sha256 } from "../src/lib/receipt";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

/** An absolute log path outside every repository, for oracles to report into. */
const logFile = (): string => join(mkdtempSync(join(tmpdir(), "sddx-oracle-log-")), "log");

const readLog = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];

type Verified = {
  phase: string;
  verified?: {
    tree_sha: string;
    base_sha: string;
    test_files: string[];
    red: { exit_code: number };
    green: Array<{ exit_code: number }>;
  };
  last_failure?: { half: string; exit_code: number; message: string };
};
const state = (cwd: string, id: string) => readTaskState(cwd, id) as unknown as Verified;

function commitFile(cwd: string, path: string, content: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, "add", path);
  git(cwd, "commit", "-qm", `add ${path}`);
}

/** Hashes of every file outside .git and .sddx, keyed by relative path. */
function contentHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === ".git" || e === ".sddx") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = sha256(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

describe("verify preconditions", () => {
  scenario("task-verification", "Wrong state", () => {
    const cwd = fixtureRepo();
    const log = logFile();
    createRun(cwd, { tasks: [{ id: "T1", run: `echo ran >> ${log}; test -f T1.done` }] });
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("verify requires IN_PROGRESS");
    expect(readLog(log)).toEqual([]);
  });

  scenario("task-verification", "Manual oracle", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", type: "manual" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manual oracle, which needs a human");
  });
});

describe("the verified tree", () => {
  scenario("task-verification", "Untracked new file is included", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", scope: ["src/rl/**", "T1.done"] }] });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "src", "rl"), { recursive: true });
    writeFileSync(join(wt, "src", "rl", "bucket.ts"), "export const b = 1;\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const tree = state(cwd, "T1").verified?.tree_sha as string;
    expect(git(cwd, "ls-tree", "-r", "--name-only", tree).split("\n")).toContain(
      "src/rl/bucket.ts",
    );
  });

  scenario("task-verification", "Worktree content untouched", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    writeFileSync(join(wt, "notes.txt"), "scratch\n");
    const before = contentHashes(wt);
    const index = sha256(readFileSync(join(cwd, ".git", "worktrees", "T1", "index")));
    expect(sddx(cwd, "verify", "T1").status).toBe(1);
    expect(contentHashes(wt)).toEqual(before);
    expect(sha256(readFileSync(join(cwd, ".git", "worktrees", "T1", "index")))).toBe(index);
  });
});

describe("the RED half", () => {
  scenario("task-verification", "New test fails against old code", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [{ id: "T1", run: "bun test tests/rl.test.ts", scope: ["src/rl/**"] }],
    });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "tests"), { recursive: true });
    mkdirSync(join(wt, "src", "rl"), { recursive: true });
    writeFileSync(
      join(wt, "tests", "rl.test.ts"),
      'import { expect, test } from "bun:test";\nimport { allow } from "../src/rl/bucket";\ntest("allow", () => expect(allow()).toBe(true));\n',
    );
    writeFileSync(join(wt, "src", "rl", "bucket.ts"), "export const allow = () => true;\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(0);
    const v = state(cwd, "T1").verified;
    expect(v?.red.exit_code).toBe(1);
    expect(v?.test_files).toEqual(["tests/rl.test.ts"]);
  });

  scenario("task-verification", "Oracle that cannot fail", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", run: "exit 0" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the oracle passes without the change");
    expect(state(cwd, "T1").phase).toBe("IN_PROGRESS");
  });

  scenario("task-verification", "Implementation files stay at base", () => {
    const cwd = fixtureRepo();
    commitFile(cwd, "src/rl/bucket.ts", "OLD\n");
    const log = logFile();
    const oracle = `{ test -f tests/rl.test.ts && echo test:yes || echo test:no; cat src/rl/bucket.ts; } >> ${log}; grep -q NEW src/rl/bucket.ts`;
    createRun(cwd, { tasks: [{ id: "T1", run: oracle, scope: ["src/rl/**"] }] });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "tests"), { recursive: true });
    writeFileSync(join(wt, "tests", "rl.test.ts"), "// test\n");
    writeFileSync(join(wt, "src", "rl", "bucket.ts"), "NEW\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(readLog(log)).toEqual(["test:yes", "OLD", "test:yes", "NEW"]);
  });

  scenario("task-verification", "Custom test glob", () => {
    const cwd = fixtureRepo();
    const log = logFile();
    createRun(cwd, {
      tasks: [
        {
          id: "T1",
          run: `{ test -f checks/rl_check.sh && echo yes || echo no; } >> ${log}; test -f T1.done`,
        },
      ],
    });
    writeConfig(cwd, { interaction_mode: "human", test_globs: "checks/**" });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "checks"), { recursive: true });
    writeFileSync(join(wt, "checks", "rl_check.sh"), "exit 0\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(readLog(log)[0]).toBe("yes");
    expect(state(cwd, "T1").verified?.test_files).toEqual(["checks/rl_check.sh"]);
  });

  test("a deleted test file is deleted in the proof worktree too", () => {
    const cwd = fixtureRepo();
    commitFile(cwd, "tests/old.test.ts", "// legacy\n");
    const log = logFile();
    createRun(cwd, {
      tasks: [
        {
          id: "T1",
          run: `{ test -f tests/old.test.ts && echo present || echo gone; } >> ${log}; test -f T1.done`,
          scope: ["T1.done", "tests/**"],
        },
      ],
    });
    const wt = startTask(cwd, "T1");
    git(wt, "rm", "-q", "tests/old.test.ts");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(readLog(log)[0]).toBe("gone");
  });
});

describe("the GREEN half", () => {
  scenario("task-verification", "All runs pass", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", oracleExtra: "runs: 3" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const green = state(cwd, "T1").verified?.green ?? [];
    expect(green.map((g) => g.exit_code)).toEqual([0, 0, 0]);
  });

  scenario("task-verification", "Flaky run fails fast", () => {
    const cwd = fixtureRepo();
    const counter = logFile();
    const oracle = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; test -f T1.done && [ $n -ne 3 ]`;
    createRun(cwd, { tasks: [{ id: "T1", run: oracle }], name: "2026-01-01-flaky" });
    const wt = startTask(cwd, "T1");
    writeConfig(cwd, { interaction_mode: "human", oracle_runs_default: 3 });
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run 2 of 3");
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
    expect(state(cwd, "T1").phase).toBe("IN_PROGRESS");
  });

  scenario("task-verification", "Broken environment cannot fake RED", () => {
    const cwd = fixtureRepo();
    commitFile(cwd, ".gitignore", "node_modules/\n");
    createRun(cwd, {
      tasks: [{ id: "T1", run: "test -f node_modules/dep.js && test -f T1.done" }],
    });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "dep.js"), "\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(state(cwd, "T1").last_failure?.half).toBe("green");
    expect(state(cwd, "T1").phase).toBe("IN_PROGRESS");
  });

  test("oracle.setup prepares the proof worktree for both halves", () => {
    const cwd = fixtureRepo();
    commitFile(cwd, ".gitignore", "node_modules/\n");
    createRun(cwd, {
      tasks: [
        {
          id: "T1",
          run: "test -f node_modules/dep.js && test -f T1.done",
          oracleExtra: "setup: mkdir -p node_modules && touch node_modules/dep.js",
        },
      ],
    });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(state(cwd, "T1").verified?.red.exit_code).toBe(1);
  });

  test("a failing setup fails verify", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", oracleExtra: "setup: exit 7" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(1);
    expect(state(cwd, "T1").last_failure).toMatchObject({ half: "setup", exit_code: 7 });
  });
});

describe("verify outcome", () => {
  scenario("task-verification", "Pass moves to review", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(0);
    const tree = state(cwd, "T1").verified?.tree_sha as string;
    expect(r.stdout).toContain(tree);
    expect(state(cwd, "T1").phase).toBe("IN_REVIEW");
  });

  scenario("task-verification", "Failure is recorded", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    const t = state(cwd, "T1");
    expect(t.phase).toBe("IN_PROGRESS");
    expect(t.last_failure).toMatchObject({ half: "green", exit_code: 1 });
  });

  scenario("task-verification", "Cleanup after failure", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", run: "exit 0" }] });
    startTask(cwd, "T1");
    expect(sddx(cwd, "verify", "T1").status).toBe(1);
    expect(git(cwd, "worktree", "list")).not.toContain("--proof");
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1--proof"))).toBe(false);
  });
});

describe("orphaned proof worktrees", () => {
  test("sweep removes a proof worktree left behind by a killed verify", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    const orphan = join(cwd, ".sddx-worktrees", "T1--proof");
    git(cwd, "worktree", "add", "-q", "--detach", orphan, "HEAD");
    const r = sddx(cwd, "sweep");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`swept ${orphan}`);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1"))).toBe(true);
  });
});

describe("scope", () => {
  scenario("task-verification", "Write outside scope", () => {
    const cwd = fixtureRepo();
    const log = logFile();
    createRun(cwd, {
      tasks: [
        { id: "T1", run: `echo ran >> ${log}; test -f T1.done`, scope: ["src/rl/**", "T1.done"] },
      ],
    });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "src", "api"), { recursive: true });
    writeFileSync(join(wt, "src", "api", "server.ts"), "export {};\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/api/server.ts");
    expect(r.stderr).toContain("outside");
    expect(readLog(log)).toEqual([]);
  });

  scenario("task-verification", "Test file outside scope is fine", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", scope: ["src/rl/**", "T1.done"] }] });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "tests"), { recursive: true });
    writeFileSync(join(wt, "tests", "rl.test.ts"), "// test\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
  });
});
