// One authoritative run summary, then one goal-scoped menu.
//
// The report used to carry three coarse counts (merged / failed / outstanding)
// and no per-task detail beyond an oracle verdict, so a reader could not tell a
// task that conflicted on integration from one still in flight, nor find the
// receipt backing a "pass". A partial run — the common case — was exactly where
// it said least.
//
// The generic current-branch action catalog is gone with it: a menu keyed to
// "is this branch pushed" answered a question about the checkout, not about the
// run, and it could offer per-task handoffs before the run reached its single
// user handoff.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateRunReport, renderRunReport } from "../src/lib/runreport";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, GRAPH_HEADER, GRAPH_HEADER_LINES, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });

const spec = (task: string, part: string, extra = "") =>
  `task: ${task}\nsuccess_criteria:\n  - a\nscope:\n  - ${part}/**\noracle:\n  type: command\n  run: "test -f ${part}/out.txt"\n${extra}`;

/**
 * A goal with three shapes at once: one task that will merge, one that will be
 * abandoned, and one dependent that is therefore skipped.
 */
function partialPlan(cwd: string): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  writeFileSync(join(cwd, "specs", "ok.yaml"), spec("build the good part", "good"));
  writeFileSync(join(cwd, "specs", "bad.yaml"), spec("build the doomed part", "doomed"));
  writeFileSync(join(cwd, "specs", "dep.yaml"), spec("build the dependent part", "dependent"));
  writeFileSync(
    join(cwd, "graph.yaml"),
    [
      ...GRAPH_HEADER_LINES,
      "goal: ship the widget",
      "tasks:",
      "  - alias: ok",
      "    spec: specs/ok.yaml",
      "  - alias: bad",
      "    spec: specs/bad.yaml",
      "  - alias: dep",
      "    spec: specs/dep.yaml",
      "    depends_on: bad",
    ].join("\n"),
  );
  return "graph.yaml";
}

function create(cwd: string, rel: string) {
  expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
  const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout).data;
  return {
    goalId: data.goalId as string,
    byAlias: data.aliasToId as Record<string, string>,
  };
}

function complete(cwd: string, id: string, part: string): void {
  const wt = join(cwd, ".sddx-worktrees", id);
  expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
  fakeRedCheck(wt, id);
  mkdirSync(join(wt, part), { recursive: true });
  writeFileSync(join(wt, part, "out.txt"), "done\n");
  expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
  expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
  expect(cli(wt, "verify", id).status).toBe(0);
}

/** Builds the partial run once: `ok` merged, `bad` abandoned, `dep` skipped. */
function partialRun() {
  const { clone: cwd } = fixtureClone();
  const rel = partialPlan(cwd);
  const { goalId, byAlias } = create(cwd, rel);
  complete(cwd, byAlias.ok as string, "good");
  const badWt = join(cwd, ".sddx-worktrees", byAlias.bad as string);
  expect(cli(badWt, "task", "phase", byAlias.bad as string, "ABANDONED").status).toBe(0);
  return { cwd, goalId, byAlias };
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
    expect(r.merged + r.failed + r.skipped + r.blocked + r.outstanding).toBe(r.total);
  });

  test("every task carries its status, receipt path, and integration result", () => {
    const { cwd, goalId, byAlias } = partialRun();
    const r = generateRunReport(cwd, goalId, "main");

    const ok = r.tasks.find((t) => t.taskId === byAlias.ok);
    expect(ok?.status).toBe("merged");
    expect(ok?.receiptPath).toBeTruthy();
    expect(ok?.integration).toBe("merged");

    const bad = r.tasks.find((t) => t.taskId === byAlias.bad);
    expect(bad?.status).toBe("failed");
    expect(bad?.receiptPath).toBeNull();
    expect(bad?.integration).toBeNull();

    const dep = r.tasks.find((t) => t.taskId === byAlias.dep);
    expect(dep?.status).toBe("skipped");
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
    const out = cli(cwd, "run", "report", "--goal", goalId, "--output", "json");
    expect(out.status).toBe(0);
    const data = JSON.parse(out.stdout).data;
    expect(data.tasks).toHaveLength(3);
    for (const t of data.tasks) {
      expect(t).toHaveProperty("taskId");
      expect(t).toHaveProperty("status");
      expect(t).toHaveProperty("oracle");
      expect(t).toHaveProperty("receiptPath");
      expect(t).toHaveProperty("integration");
    }
    for (const k of ["merged", "failed", "skipped", "blocked", "conflicted", "outstanding"]) {
      expect(data).toHaveProperty(k);
    }
  });
});

describe("next-actions is goal-scoped only", () => {
  test("without --goal it exits nonzero and produces no current-branch menu", () => {
    const { cwd } = partialRun();
    const r = cli(cwd, "next-actions");
    expect(r.status).not.toBe(0);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).toContain("--goal");
    // none of the retired current-branch actions appear
    expect(all).not.toContain("Push Branch");
    expect(all).not.toContain("Commit Changes");
  });

  test("with --goal it renders the run menu", () => {
    const { cwd, goalId } = partialRun();
    const r = cli(cwd, "next-actions", "--goal", goalId);
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
  test("verify emits no action menu of its own", () => {
    const { clone: cwd } = fixtureClone();
    mkdirSync(join(cwd, "specs"), { recursive: true });
    writeFileSync(join(cwd, "specs", "ok.yaml"), spec("build the good part", "good"));
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: ship the widget\ntasks:\n  - alias: ok\n    spec: specs/ok.yaml\n`,
    );
    const { byAlias } = create(cwd, "graph.yaml");
    const id = byAlias.ok as string;
    const wt = join(cwd, ".sddx-worktrees", id);

    expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    fakeRedCheck(wt, id);
    mkdirSync(join(wt, "good"), { recursive: true });
    writeFileSync(join(wt, "good", "out.txt"), "done\n");
    expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);

    const v = cli(wt, "verify", id);
    expect(v.status).toBe(0);
    const out = `${v.stdout}${v.stderr}`;
    expect(out).not.toContain("Next Actions");
    expect(out).not.toContain("Review Changes");
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
