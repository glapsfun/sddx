import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/lib/receipt";
import { fixtureRepo, writeConfig } from "./fixtures";
import {
  completeTask,
  createRun,
  doneFile,
  readGoalAnywhere,
  readTaskState,
  sddx,
  startTask,
} from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const GOAL = "2026-01-01-test-goal";

function toReview(cwd: string, id: string): string {
  const wt = startTask(cwd, id);
  writeFileSync(join(wt, doneFile(id)), "done\n");
  const v = sddx(cwd, "verify", id);
  if (v.status !== 0) throw new Error(`verify ${id}: ${v.stderr}`);
  return wt;
}

type Reviewed = {
  phase: string;
  verified?: { base_sha: string; tree_sha: string };
  reviews: Array<{
    verdict: string;
    diff_sha256: string;
    findings_sha256?: string;
    reviewer: string | null;
  }>;
};
const state = (cwd: string, id: string) => readTaskState(cwd, id) as unknown as Reviewed;

function findings(cwd: string, text = "the limit is off by one\n"): string {
  const path = join(cwd, "review.md");
  writeFileSync(path, text);
  return path;
}

describe("review preconditions", () => {
  scenario("task-review", "Wrong state", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("requires IN_REVIEW");
  });

  scenario("task-review", "Failing review without findings", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "fail");
    expect(r.status).toBe(2);
    expect(state(cwd, "T1").phase).toBe("IN_REVIEW");
  });

  test("an unknown verdict is a usage error", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "maybe").status).toBe(2);
  });
});

describe("binding to the verified diff", () => {
  scenario("task-review", "Work changed after verify", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = toReview(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "changed after verify\n");
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the work changed after verify");
    expect(state(cwd, "T1").phase).toBe("IN_PROGRESS");
  });

  scenario("task-review", "Diff hash recorded", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const { base_sha, tree_sha } = state(cwd, "T1").verified as {
      base_sha: string;
      tree_sha: string;
    };
    const diff = spawnSync("git", ["diff", "--binary", base_sha, tree_sha], { cwd }).stdout;
    expect(
      sddx(cwd, "review", "record", "T1", "--verdict", "fail", "--findings", findings(cwd)).status,
    ).toBe(0);
    expect(state(cwd, "T1").reviews[0]?.diff_sha256).toBe(sha256(diff));
  });
});

describe("outcomes", () => {
  scenario("task-review", "Review fails", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const f = findings(cwd);
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "fail", "--findings", f);
    expect(r.status).toBe(0);
    const t = state(cwd, "T1");
    expect(t.phase).toBe("IN_PROGRESS");
    expect(t.reviews[0]?.verdict).toBe("fail");
    expect(t.reviews[0]?.findings_sha256).toBe(sha256(readFileSync(f)));
  });

  scenario("task-review", "Pass finalizes", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = toReview(cwd, "T1");
    const r = sddx(
      cwd,
      "review",
      "record",
      "T1",
      "--verdict",
      "pass",
      "--reviewer",
      "critic",
      "--output",
      "json",
    );
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout).data as {
      receiptPath: string;
      commitSha: string;
      phase: string;
    };
    expect(data.phase).toBe("DONE");
    expect(readFileSync(data.receiptPath, "utf8")).toContain('"version": 5');
    const merge = git(cwd, "rev-parse", run.runBranch);
    expect(git(cwd, "rev-parse", `${merge}^2`)).toBe(data.commitSha);
    // one commit holds the code, the task state and the receipt
    const files = git(wt, "show", "--name-only", "--format=", data.commitSha).split("\n").sort();
    expect(files).toEqual([".sddx/receipts/T1.json", ".sddx/tasks/T1.json", "T1.done"]);
  });

  scenario("task-review", "Merge conflict is recorded, not hidden", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    for (const id of ["T1", "T2"]) {
      const wt = startTask(cwd, id);
      mkdirSync(join(wt, "tests"), { recursive: true });
      writeFileSync(join(wt, "tests", "shared.test.ts"), `// written by ${id}\n`);
      writeFileSync(join(wt, doneFile(id)), "done\n");
      expect(sddx(cwd, "verify", id).status).toBe(0);
    }
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    const before = git(cwd, "rev-parse", run.runBranch);
    const r = sddx(cwd, "review", "record", "T2", "--verdict", "pass");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("integration conflict");
    expect(r.stdout).toContain("tests/shared.test.ts");
    expect(git(cwd, "rev-parse", run.runBranch)).toBe(before);
    const goal = readGoalAnywhere(cwd, GOAL) as {
      merges: Array<{ task_id: string; result: string }>;
    };
    expect(goal.merges.find((m) => m.task_id === "T2")?.result).toBe("conflict");
  });

  scenario("task-review", "Auto mode still reviews", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "auto" });
    createRun(cwd, { tasks: [{ id: "T1" }], approve: false });
    toReview(cwd, "T1");
    expect(state(cwd, "T1").phase).toBe("IN_REVIEW");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    expect(state(cwd, "T1").phase).toBe("DONE");
  });

  test("a failed review counts toward the iteration limit", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    sddx(cwd, "review", "record", "T1", "--verdict", "fail", "--findings", findings(cwd));
    expect((readTaskState(cwd, "T1") as unknown as { iterations: number }).iterations).toBe(2);
  });
});

describe("audit wording", () => {
  scenario("task-review", "Audit wording", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = toReview(cwd, "T1");
    sddx(cwd, "review", "record", "T1", "--verdict", "pass", "--reviewer", "critic");
    const receipt = JSON.parse(readFileSync(join(wt, ".sddx", "receipts", "T1.json"), "utf8"));
    const r = sddx(wt, "audit");
    expect(r.status).toBe(0);
    const hash = String(receipt.review.diff_sha256).slice(0, 12);
    expect(r.stdout).toContain(`review recorded by reported reviewer critic for diff ${hash}`);
    expect(r.stdout).toContain("a recorded review, not a verified one");
  });

  test("completeTask leaves a task DONE with a receipt", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { receiptPath } = completeTask(cwd, "T1");
    expect(readFileSync(receiptPath, "utf8")).toContain('"task_id": "T1"');
  });
});
