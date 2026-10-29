// One authoritative run summary, then one goal-scoped menu.
//
// The report used to carry three coarse counts (merged / failed / outstanding)
// and no per-task detail beyond an oracle verdict, so a reader could not tell a
// task that conflicted on integration from one still in flight, nor find the
// receipt backing a "pass". A partial run, the common case, was exactly where
// it said least.
//
// The generic current-branch action catalog is gone with it: a menu keyed to
// "is this branch pushed" answered a question about the checkout, not about the
// run, and it could offer per-task handoffs before the run reached its single
// user handoff.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateRunReport, renderRunReport } from "../src/lib/runreport";
import { fixtureClone } from "./fixtures";
import { completeTask, createRun, doneFile, repoRoot, sddx, startTask } from "./helpers";

// each test drives whole tasks through the CLI, which can exceed the 5s default under load
setDefaultTimeout(60_000);

/**
 * A goal with three shapes at once: T1 merges, T2 is abandoned, and T3, which
 * depends on T2, is therefore skipped.
 */
function partialRun() {
  const { clone: cwd } = fixtureClone();
  const { goalId } = createRun(cwd, {
    tasks: [{ id: "T1" }, { id: "T2" }, { id: "T3", dependsOn: ["T2"] }],
  });
  completeTask(cwd, "T1");
  startTask(cwd, "T2");
  expect(sddx(cwd, "task", "abandon", "T2", "--reason", "dead end").status).toBe(0);
  return { cwd, goalId };
}

describe("a partial run reports completely in one summary", () => {
  test("counts distinguish merged, failed, skipped, and outstanding", () => {
    const { cwd, goalId } = partialRun();
    const r = generateRunReport(cwd, goalId, "main");

    expect(r.merged).toBe(1);
    expect(r.failed).toBe(1);
    // the dependent of an abandoned parent is skipped, not merely outstanding
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(3);
    // every task is accounted for exactly once
    expect(r.merged + r.failed + r.skipped + r.blocked + r.conflicted + r.outstanding).toBe(
      r.total,
    );
  });

  test("every task carries its status, receipt path, and integration result", () => {
    const { cwd, goalId } = partialRun();
    const r = generateRunReport(cwd, goalId, "main");

    const ok = r.tasks.find((t) => t.taskId === "T1");
    expect(ok?.status).toBe("merged");
    expect(ok?.state).toBe("DONE");
    expect(ok?.receiptPath).toBeTruthy();
    expect(ok?.integration).toBe("merged");

    const bad = r.tasks.find((t) => t.taskId === "T2");
    expect(bad?.status).toBe("failed");
    expect(bad?.reason).toBe("dead end");
    expect(bad?.receiptPath).toBeNull();
    expect(bad?.integration).toBeNull();

    const dep = r.tasks.find((t) => t.taskId === "T3");
    expect(dep?.status).toBe("skipped");
    expect(dep?.because).toBe("T2");
    expect(dep?.reason).toBe("skipped");
  });

  test("the rendered summary states the target branch is unchanged", () => {
    const { cwd, goalId } = partialRun();
    const text = renderRunReport(generateRunReport(cwd, goalId, "main"));
    expect(text).toContain("Target branch remains unchanged: main");
    // not "completed": one task failed and one was skipped. Keying the headline
    // on `outstanding` alone let the summary contradict its own counts.
    expect(text).toContain("Run finished with unresolved tasks");
  });

  test("JSON carries the full field set even where the terminal collapses", () => {
    const { cwd, goalId } = partialRun();
    const out = sddx(cwd, "run", "report", "--goal", goalId, "--output", "json");
    expect(out.status).toBe(0);
    const data = JSON.parse(out.stdout).data;
    expect(data.tasks).toHaveLength(3);
    for (const t of data.tasks) {
      for (const k of [
        "taskId",
        "status",
        "state",
        "attempt",
        "reason",
        "oracle",
        "receiptPath",
        "integration",
      ]) {
        expect(t).toHaveProperty(k);
      }
    }
    for (const k of ["merged", "failed", "skipped", "blocked", "conflicted", "outstanding"]) {
      expect(data).toHaveProperty(k);
    }
  });
});

describe("next-actions is goal-scoped only", () => {
  test("without --goal it exits nonzero and produces no current-branch menu", () => {
    const { cwd } = partialRun();
    const r = sddx(cwd, "next-actions");
    expect(r.status).not.toBe(0);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).toContain("--goal");
    // none of the retired current-branch actions appear
    expect(all).not.toContain("Push Branch");
    expect(all).not.toContain("Commit Changes");
  });

  test("with --goal it renders the run menu", () => {
    const { cwd, goalId } = partialRun();
    const r = sddx(cwd, "next-actions", "--goal", goalId);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Review Changes");
  });

  test("the retired catalog is gone from the source, not merely unrouted", () => {
    const src = spawnSync("grep", ["-rn", "visibleActions\\|detectState(", "src/"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(src.stdout ?? "").toBe("");
  });
});

describe("no per-task menu after verification", () => {
  test("neither verify nor review record emits an action menu of its own", () => {
    const { clone: cwd } = fixtureClone();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");

    for (const r of [
      sddx(cwd, "verify", "T1"),
      sddx(cwd, "review", "record", "T1", "--verdict", "pass"),
    ]) {
      expect(r.status).toBe(0);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).not.toContain("Next Actions");
      expect(out).not.toContain("Review Changes");
    }
  });

  test("no role or skill invokes next-actions without --goal", () => {
    // A bare `next-actions` is the retired per-task menu; the goal-scoped form
    // is the one legitimate handoff and may appear freely.
    const hits = spawnSync("grep", ["-rn", "next-actions", "agents/", "skills/"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const bare = (hits.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes("--goal"));
    expect(bare).toEqual([]);
  });
});
