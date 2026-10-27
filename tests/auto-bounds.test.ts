import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, SELF_MODIFYING_GLOBS } from "../src/lib/approval";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { parseGoalSpec } from "../src/lib/goalspec";
import { fixtureClone, fixtureRepo, writeConfig } from "./fixtures";
import {
  createRun,
  goalIds,
  goalSpec,
  type SpecTaskInput,
  sddx,
  startTask,
  writeSpec,
} from "./helpers";

// Interaction mode is config-only by design (see config.ts interactionMode): the
// environment is part of the command line the agent composes, so it must not be
// able to switch the gate. Tests therefore write config, exactly as a user does.
function withMode(cwd: string, mode: "human" | "auto", autoMaxTasks?: number): void {
  writeConfig(cwd, {
    interaction_mode: mode,
    ...(autoMaxTasks ? { auto_max_tasks: autoMaxTasks } : {}),
  });
}

const NAME = "2026-01-01-ship-the-widget";

function planRepo(
  cwd: string,
  tasks: number,
  perTask: (i: number) => Partial<SpecTaskInput> = (i) => ({ scope: [`src/n${i}/**`] }),
  openDecisions: string[] = [],
): string {
  return writeSpec(
    cwd,
    NAME,
    goalSpec({
      title: "ship the widget",
      tasks: Array.from({ length: tasks }, (_, i) => ({ id: `n${i}`, ...perTask(i) })),
      openDecisions,
    }),
  );
}

describe("auto mode refuses a manual oracle", () => {
  test("hard refusal at start, before any approval is requested", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2, (i) =>
      i === 1 ? { scope: ["src/n1/**"], type: "manual" } : { scope: ["src/n0/**"] },
    );
    withMode(cwd, "auto");
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("n1");
    expect(r.stderr).toContain("manual");
    expect(goalIds(cwd)).toEqual([]);
  });

  test("refusal is not an approval prompt; it names incoherence, not a missing token", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: ["src/n0/**"], type: "manual" }));
    withMode(cwd, "auto");
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.stderr).not.toContain("plan approve");
  });

  test("a browser oracle is still permitted under auto", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: ["src/n0/**"], type: "browser" }));
    withMode(cwd, "auto");
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).toBe(0);
    expect(goalIds(cwd)).toHaveLength(1);
  });

  test("human mode may still plan a manual oracle", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: ["src/n0/**"], type: "manual" }));
    withMode(cwd, "human");
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    expect(sddx(cwd, "plan", "start", rel).status).toBe(0);
  });
});

describe("auto mode never widens the strict gate", () => {
  // `task allow` exists only in the strict profile, where the allow list is the
  // one escape from the per-edit gate.
  const strict = (cwd: string, mode: "human" | "auto") =>
    writeConfig(cwd, { interaction_mode: mode, profile: "strict" });

  /** One started task in its own one-task run; returns its id and its worktree,
   * which is where the task state lives and where `task allow` is actually run. */
  function taskInRepo(cwd: string, mode: "human" | "auto" = "human"): { id: string; wt: string } {
    strict(cwd, mode);
    const { taskIds } = createRun(cwd, {
      tasks: [{ id: "T1", scope: ["src/widget/**"] }],
      approve: mode === "human",
    });
    const id = taskIds[0] as string;
    return { id, wt: startTask(cwd, id) };
  }

  const allowOf = (wt: string, id: string): string[] =>
    JSON.parse(readFileSync(join(wt, ".sddx", "tasks", `${id}.json`), "utf8")).allow ?? [];

  test("task allow is refused under auto mode with no entry written", () => {
    const cwd = fixtureRepo();
    const { id, wt } = taskInRepo(cwd);
    strict(cwd, "auto");
    const r = sddx(cwd, "task", "allow", id, "src/migration.sql");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refused in auto mode");
    expect(r.stderr.toLowerCase()).toContain("human");
    expect(allowOf(wt, id)).toEqual([]);
  });

  test("task allow is refused from inside a worktree, where config.json is absent", () => {
    // `task allow` is run BY the executor, from its own worktree, and
    // `.sddx/config.json` is not committed, so a worktree forked from the run
    // branch has no copy. Reading the mode from the process cwd returned `{}`
    // there, which resolves to `human`, silently granting the one escape hatch
    // from the gate on exactly the unattended runs it exists to stop.
    const { clone: cwd } = fixtureClone();
    const { id, wt } = taskInRepo(cwd, "auto");
    expect(existsSync(join(wt, ".sddx", "config.json"))).toBe(false);

    const r = sddx(wt, "task", "allow", id, "src/migration.sql");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refused in auto mode");
    expect(r.stderr.toLowerCase()).toContain("human");
    expect(allowOf(wt, id)).toEqual([]);
  });

  test("task allow still succeeds under human mode and is recorded", () => {
    const cwd = fixtureRepo();
    const { id, wt } = taskInRepo(cwd);
    const r = sddx(wt, "task", "allow", id, "src/migration.sql");
    expect(r.status).toBe(0);
    expect(allowOf(wt, id)).toContain("src/migration.sql");
  });
});

describe("auto mode blast radius", () => {
  test("a plan over auto_max_tasks is refused, not armed", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "auto", 3);
    const r = sddx(cwd, "plan", "start", rel);
    // exit 3 means "approval required"; a bound refuses instead, so not 3
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("auto_max_tasks");
    expect(goalIds(cwd)).toEqual([]);
  });

  test("within the ceiling it proceeds unattended", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "auto", 3);
    expect(sddx(cwd, "plan", "start", rel).status).toBe(0);
  });

  test("a self-modifying scope is refused regardless of task count", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1, () => ({ scope: ["hooks/**"] }));
    withMode(cwd, "auto", 99);
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("n0");
    expect(r.stderr).toContain("enforcement paths");
    expect(goalIds(cwd)).toEqual([]);
  });

  test("auto cannot approve its way past a bound", () => {
    // Previously a token let an over-ceiling plan run unattended, recording the
    // degradation on the token. Approving is a human act, so it belongs to
    // human mode, reached by editing reviewed configuration, not by a token.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "auto", 3);
    const approve = sddx(cwd, "plan", "approve", rel);
    expect(approve.status).not.toBe(0);
    expect(approve.stderr).toContain("auto_max_tasks");
    expect(sddx(cwd, "plan", "start", rel).status).not.toBe(0);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("the same plan runs once configuration selects human mode", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 4);
    withMode(cwd, "human", 3);
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    expect(sddx(cwd, "plan", "start", rel).status).toBe(0);
  });
});

describe("decideGate refuses rather than degrading", () => {
  const nodes = (n: number, scope = (i: number) => [`src/n${i}/**`]) =>
    Array.from({ length: n }, (_, i) => ({
      alias: `n${i}`,
      scope: scope(i),
      oracleType: "command",
    }));

  const specOn = (cwd: string, n: number, openDecisions: string[] = []): string =>
    join(cwd, planRepo(cwd, n, undefined, openDecisions));

  const openDecisionsOf = (spec: string): string[] =>
    parseGoalSpec(readFileSync(spec, "utf8")).spec?.design.openDecisions ?? ["(unparseable)"];

  test("names the requested mode and the triggering bound", () => {
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 4);
    const d = decideGate(cwd, spec, nodes(4), "auto", 3, scopesOverlap, []);
    expect(d.ok).toBe(false);
    expect(d.requestedMode).toBe("auto");
    // the mode is not rewritten to "human": nothing degraded
    expect(d.mode).toBe("auto");
    expect(d.refusal).toContain("auto_max_tasks");
    expect(d.nodeCount).toBe(4);
  });

  test("a non-empty Open decisions list refuses an auto plan that clears every path bound", () => {
    // The additive half of the blocker rule: a decision nobody has made yet. It
    // is layered ON TOP of the deterministic bounds, never instead of them; see
    // the protected-path test below.
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 2, ["should signup collect date of birth?"]);
    const d = decideGate(cwd, spec, nodes(2), "auto", 99, scopesOverlap, openDecisionsOf(spec));
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("should signup collect date of birth?");
  });

  test("the same open decision is untouched in human mode, where a human already reviews it", () => {
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 2, ["should signup collect date of birth?"]);
    const d = decideGate(cwd, spec, nodes(2), "human", 99, scopesOverlap, openDecisionsOf(spec));
    expect(d.refusal).toBeUndefined();
  });

  test("a protected-path plan refuses even when the spec lists no open decisions", () => {
    // The point of the deterministic bounds: they do not consult the
    // self-report, so a model that assumes its way past an auth decision and
    // leaves Open decisions empty still cannot run unattended.
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 2);
    expect(openDecisionsOf(spec)).toEqual([]);
    const d = decideGate(
      cwd,
      spec,
      nodes(2, (i) => (i === 1 ? ["src/auth/**"] : ["src/n0/**"])),
      "auto",
      99,
      scopesOverlap,
      openDecisionsOf(spec),
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("auth");
  });

  test("self-modification is reported with the offending task and paths", () => {
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 2);
    const d = decideGate(
      cwd,
      spec,
      nodes(2, (i) => (i === 1 ? [".github/workflows/**"] : ["src/n0/**"])),
      "auto",
      99,
      scopesOverlap,
      [],
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("n1");
    for (const glob of SELF_MODIFYING_GLOBS) expect(d.refusal).toContain(glob);
  });

  test("self-modification outranks the ceiling when both apply", () => {
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 4);
    const d = decideGate(
      cwd,
      spec,
      nodes(4, (i) => (i === 0 ? ["hooks/**"] : [`src/n${i}/**`])),
      "auto",
      1,
      scopesOverlap,
      [],
    );
    expect(d.refusal).toContain("enforcement paths");
  });

  test("an UNSCOPED task is refused; empty scope is unconfined", () => {
    // An empty scope means the task may write anywhere, which includes hooks/,
    // .claude/, and every protected path. Treating "no scope" as "no reach"
    // penalized honest scope declarations and made omitting `scope` a bypass.
    const cwd = fixtureRepo();
    const spec = specOn(cwd, 1);
    const d = decideGate(
      cwd,
      spec,
      [{ alias: "n0", scope: [], oracleType: "command" }],
      "auto",
      6,
      scopesOverlap,
      [],
    );
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("unconfined");
  });

  test("an unhashable plan is never approved", () => {
    const cwd = fixtureRepo();
    const d = decideGate(
      cwd,
      join(cwd, ".sddx", "specs", "missing.md"),
      nodes(1),
      "auto",
      6,
      scopesOverlap,
      [],
    );
    expect(d.ok).toBe(false);
    expect(d.hash).toBe("");
  });
});
