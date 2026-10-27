import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalGate } from "../src/lib/approvalgate";
import { recordTestRun } from "../src/lib/recorder";
import { readTask, writeTask } from "../src/lib/task";
import { blockMessage, tddGate } from "../src/tdd-gate";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, startTask } from "./helpers";

/** T1 started under the strict profile. `scope: null` leaves it unconfined. */
function strictTask(
  scope: string[] | null = ["T1.done"],
  extra: Record<string, unknown> = {},
): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  writeConfig(cwd, { interaction_mode: "human", profile: "strict", ...extra });
  createRun(cwd, { tasks: [{ id: "T1", scope }] });
  return { cwd, wt: startTask(cwd, "T1") };
}

/** Records a failing test run, which lifts the test-first half of the gate. */
const seenFailing = (wt: string): void => {
  expect(recordTestRun(wt, "bun test", 1).recorded).toBe("RED");
};

describe("tddGate", () => {
  test("denies an implementation write before a failing test is recorded", () => {
    const { wt } = strictTask();
    const d = tddGate({ filePath: join(wt, "src", "api.ts"), cwd: wt });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("no recorded failing test");
  });

  test("a PLANNED task governs no writes: it has no worktree yet", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1", scope: null }] });
    expect(tddGate({ filePath: join(cwd, "src", "api.ts"), cwd }).allow).toBe(true);
  });

  test("allows a test write before a failing test is recorded", () => {
    const { wt } = strictTask();
    expect(tddGate({ filePath: join(wt, "tests", "api.test.ts"), cwd: wt }).allow).toBe(true);
  });

  test("allows an exempt write before a failing test is recorded", () => {
    const { wt } = strictTask();
    expect(tddGate({ filePath: join(wt, "README.md"), cwd: wt }).allow).toBe(true);
  });

  test("allow-listed file writable before a failing test is recorded", () => {
    const { wt } = strictTask();
    const t = readTask(wt, "T1");
    t.allow.push("src/migration.sql");
    writeTask(wt, t);
    expect(tddGate({ filePath: join(wt, "src", "migration.sql"), cwd: wt }).allow).toBe(true);
  });

  test("inert outside sddx repos and once tests have been seen failing", () => {
    const bare = fixtureRepo();
    writeConfig(bare, { profile: "strict" });
    expect(tddGate({ filePath: join(bare, "src", "api.ts"), cwd: bare }).allow).toBe(true);

    const { wt } = strictTask(null);
    seenFailing(wt);
    expect(tddGate({ filePath: join(wt, "src", "api.ts"), cwd: wt }).allow).toBe(true);
    expect(recordTestRun(wt, "bun test", 0).recorded).toBe("GREEN");
    expect(tddGate({ filePath: join(wt, "src", "api.ts"), cwd: wt }).allow).toBe(true);
  });

  test("cwd-relative file paths are anchored to cwd", () => {
    const { wt } = strictTask();
    expect(tddGate({ filePath: "src/api.ts", cwd: wt }).allow).toBe(false);
    expect(tddGate({ filePath: "tests/api.test.ts", cwd: wt }).allow).toBe(true);
  });

  test("test_globs honored via config input", () => {
    const { wt } = strictTask();
    const d = tddGate({
      filePath: join(wt, "checks", "health.ts"),
      cwd: wt,
      config: { testGlobs: "checks/**" },
    });
    expect(d.allow).toBe(true);
  });

  test("config file .sddx/config.json is read", () => {
    const { wt } = strictTask(["T1.done"], { test_globs: "qa/**" });
    expect(tddGate({ filePath: join(wt, "qa", "smoke.ts"), cwd: wt }, {}).allow).toBe(true);
    expect(tddGate({ filePath: join(wt, "src", "smoke.ts"), cwd: wt }, {}).allow).toBe(false);
  });

  test("ambiguous governing task denies, naming candidates", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    // two started tasks' state in one workspace: the gate must not pick one
    for (const id of ["T1", "T2"]) {
      const wt = startTask(cwd, id);
      writeFileSync(
        join(cwd, ".sddx", "tasks", `${id}.json`),
        readFileSync(join(wt, ".sddx", "tasks", `${id}.json`)),
      );
    }
    const d = tddGate({ filePath: join(cwd, "src", "api.ts"), cwd });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("T1");
      expect(d.reason).toContain("T2");
    }
  });

  test("corrupt task file denies", () => {
    const repo = fixtureRepo();
    writeConfig(repo, { profile: "strict" });
    mkdirSync(join(repo, ".sddx", "tasks"), { recursive: true });
    writeFileSync(join(repo, ".sddx", "tasks", "20260101-bad.json"), "{broken");
    const d = tddGate({ filePath: join(repo, "src", "api.ts"), cwd: repo });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("20260101-bad.json");
  });

  // KNOWN BUG, kept failing on purpose: tddGate reads the profile from `cwd`
  // (process.cwd() when absent), not from the target's repository, so a write
  // into a strict repository's worktree is allowed whenever the hook's cwd is
  // anywhere else. sddx 5 decided from the target path alone. Turn this into a
  // plain `test` once src/tdd-gate.ts reads the profile from the target.
  test("the target's repository decides, not the caller's cwd", () => {
    const { wt } = strictTask();
    const elsewhere = mkdtempSync(join(tmpdir(), "sddx-elsewhere-"));
    expect(tddGate({ filePath: join(wt, "src", "api.ts"), cwd: elsewhere }).allow).toBe(false);
  });
});

describe("scope confinement", () => {
  /** A strict task scoped to src/db/** that has seen its tests fail. */
  function scopedTask(): string {
    const { wt } = strictTask(["src/db/**"]);
    seenFailing(wt);
    return wt;
  }

  test("in-scope implementation write allowed once tests have been seen failing", () => {
    const wt = scopedTask();
    expect(tddGate({ filePath: join(wt, "src", "db", "schema.ts"), cwd: wt }).allow).toBe(true);
  });

  test("out-of-scope implementation write blocked, naming path and scope", () => {
    const wt = scopedTask();
    const d = tddGate({ filePath: join(wt, "src", "api", "users.ts"), cwd: wt });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("src/api/users.ts");
      expect(d.reason).toContain("src/db/**");
      expect(d.reason).toContain("T1");
    }
  });

  test("exempt path allowed despite being out of scope", () => {
    const wt = scopedTask();
    expect(tddGate({ filePath: join(wt, "README.md"), cwd: wt }).allow).toBe(true);
  });

  test("allow-listed out-of-scope path permitted", () => {
    const wt = scopedTask();
    const t = readTask(wt, "T1");
    t.allow.push("src/api/users.ts");
    writeTask(wt, t);
    expect(tddGate({ filePath: join(wt, "src", "api", "users.ts"), cwd: wt }).allow).toBe(true);
  });

  test("no declared scope means no confinement", () => {
    const { wt } = strictTask(null);
    seenFailing(wt);
    expect(tddGate({ filePath: join(wt, "anywhere", "file.ts"), cwd: wt }).allow).toBe(true);
  });
});

describe("blockMessage", () => {
  test("names path, task, the missing failing test, and both remedies", () => {
    const { wt } = strictTask();
    const t = readTask(wt, "T1");
    const msg = blockMessage(t, "src/api.ts", {});
    expect(msg).toContain("src/api.ts");
    expect(msg).toContain("T1");
    expect(msg).toContain("strict");
    expect(msg).toContain("failing test");
    expect(msg).toContain("sddx task allow T1 src/api.ts");
    expect(readTask(wt, "T1").phase).toBe("IN_PROGRESS");
  });
});

// Moved from the TDD gate to the approval gate in sddx 6, which guards these
// files in every profile, task or no task.
describe("approval tokens are not writable by hand", () => {
  const blocked = (filePath: string, cwd: string): string => {
    const d = approvalGate({ filePath, cwd });
    expect(d.decision).toBe("deny");
    return d.reason ?? "";
  };

  test("a direct write to .sddx/approvals/ is blocked, task or no task", () => {
    const cwd = fixtureRepo();
    // No task exists at all: the state a plan sits in before `plan start`.
    // `.sddx/**` is an EXEMPT glob for the TDD gate, so nothing else stops this.
    const reason = blocked(".sddx/approvals/deadbeef.json", cwd);
    expect(reason).toContain("approval tokens are not editable");
    expect(reason).toContain("sddx plan approve");
  });

  test("blocked via an absolute path too", () => {
    const cwd = fixtureRepo();
    blocked(join(cwd, ".sddx", "approvals", "x.json"), cwd);
  });

  test("a `..` segment does not smuggle a write past the guard", () => {
    const cwd = fixtureRepo();
    // Built by CONCATENATION, not path.join — join() collapses the `..` itself,
    // so a joined path never reproduces the bug: the gate would receive an
    // already-clean path and block it even before the fix. The literal `..` has
    // to survive into the gate, which is what an absolute filePath passed
    // through un-normalized used to do.
    for (const p of [
      `${cwd}/.sddx/tasks/../approvals/x.json`,
      // the relative spelling is a genuine, non-collapsing case in its own right:
      // a refactor that normalized only absolute paths would mirror the original
      // bug and pass a suite that covered just the absolute form
      ".sddx/tasks/../approvals/x.json",
    ]) {
      expect(blocked(p, cwd)).toContain("approval tokens are not editable");
    }

    for (const p of [`${cwd}/.sddx/tasks/../config.json`, ".sddx/tasks/../config.json"]) {
      expect(blocked(p, cwd)).toContain("interaction_mode");
    }
  });

  test(".sddx/config.json is not tool-editable — it is the only source of interaction_mode", () => {
    const cwd = fixtureRepo();
    for (const p of [".sddx/config.json", join(cwd, ".sddx", "config.json")]) {
      expect(blocked(p, cwd)).toContain("interaction_mode");
    }
  });

  test("other .sddx paths stay writable", () => {
    const cwd = fixtureRepo();
    for (const p of [
      ".sddx/specs/2026-01-01-goal.md",
      ".sddx/context/notes.md",
      ".sddx/tasks/t.json",
    ]) {
      expect(approvalGate({ filePath: p, cwd }).decision).toBe("pass");
    }
  });
});
