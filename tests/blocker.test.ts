import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, planHash, writeApproval } from "../src/lib/approval";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { fixtureClone, writeConfig } from "./fixtures";
import { doneFile, goalIds, goalSpec, sddx, writeSpec } from "./helpers";

function auto(cwd: string, maxTasks = 9): void {
  writeConfig(cwd, { interaction_mode: "auto", auto_max_tasks: maxTasks });
}

/**
 * A plan in auto mode. `scopes` gives each task its lane (null = no `scope`
 * key at all, i.e. unconfined); `openDecisions` fills the spec's Open decisions.
 */
function planRepo(
  cwd: string,
  scopes: (string | null)[],
  openDecisions: string[] = [],
  oracleTypes: string[] = [],
): string {
  return writeSpec(
    cwd,
    "2026-01-01-ship-the-widget",
    goalSpec({
      title: "ship the widget",
      openDecisions,
      tasks: scopes.map((scope, i) => ({
        id: `n${i}`,
        scope: scope === null ? null : [scope],
        ...(oracleTypes[i] ? { type: oracleTypes[i] } : {}),
      })),
    }),
  );
}

/** Everything a blocker must leave untouched. */
function runState(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)).sort() : []);
  const branches = spawnSync("git", ["branch", "--list"], { cwd, encoding: "utf8" });
  const worktrees = spawnSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
  return {
    goals: goalIds(cwd),
    tasks: dir(join(".sddx", "tasks")),
    receipts: dir(join(".sddx", "receipts")),
    approvals: dir(join(".sddx", "approvals")),
    branches: (branches.stdout ?? "").trim(),
    worktrees: (worktrees.stdout ?? "").trim().split("\n").length,
  };
}

describe("the structured blocker summary", () => {
  test("names the missing decision, its impact, and the next step", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    const r = sddx(cwd, "plan", "start", rel, "--output", "json");
    expect(r.status).not.toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("error");
    const b = out.data.blocker;
    expect(b.bound).toBe("protected-path");
    expect(b.node).toBe("n1");
    expect(b.decision).toContain("auth");
    expect(b.impact).not.toBe("");
    expect(b.next_step).toContain("interaction_mode");
  });

  test("an open decision is reported as the decision itself", () => {
    // Open decisions block planning in every mode, so the CLI refuses before
    // the gate runs and names the decision in its errors. The gate keeps the
    // structured `unresolved` bound for callers that consult it directly (the hook).
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**"], ["should signup collect date of birth?"]);
    const r = sddx(cwd, "plan", "start", rel, "--output", "json");
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("error");
    expect(out.errors.join("\n")).toContain("should signup collect date of birth?");

    const d = decideGate(
      cwd,
      join(cwd, rel),
      [{ alias: "n0", scope: ["src/n0/**"], oracleType: "command" }],
      "auto",
      9,
      scopesOverlap,
      ["should signup collect date of birth?"],
    );
    expect(d.blocker?.bound).toBe("unresolved");
    expect(d.blocker?.decision).toContain("date of birth");
  });

  test("the task-count ceiling reports as a policy bound, not a missing decision", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd, 2);
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**", "src/n2/**"]);
    const r = sddx(cwd, "plan", "start", rel, "--output", "json");
    expect(r.status).not.toBe(0);
    const b = JSON.parse(r.stdout).data.blocker;
    expect(b.bound).toBe("task-ceiling");
    expect(b.decision).toContain("auto_max_tasks");
  });

  test("a manual oracle reports as unobservable, naming the task", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**"], [], ["manual"]);
    const r = sddx(cwd, "plan", "start", rel, "--output", "json");
    const b = JSON.parse(r.stdout).data.blocker;
    expect(b.bound).toBe("manual-oracle");
    expect(b.node).toBe("n0");
  });

  test("the terminal rendering carries the same three facts", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auth");
    expect(r.stderr).toContain("interaction_mode");
  });
});

describe("a blocker is terminal", () => {
  const cases: [string, (cwd: string) => string][] = [
    ["a critical open decision", (cwd) => planRepo(cwd, ["src/n0/**"], ["which auth provider?"])],
    ["a protected-path policy", (cwd) => planRepo(cwd, ["src/n0/**", "src/migrations/**"])],
    ["an unconfined task", (cwd) => planRepo(cwd, [null])],
  ];

  for (const [label, build] of cases) {
    test(`${label} leaves zero run state`, () => {
      const { clone: cwd } = fixtureClone();
      auto(cwd);
      const rel = build(cwd);
      const before = runState(cwd);
      const r = sddx(cwd, "plan", "start", rel);
      expect(r.status).not.toBe(0);
      // not merely "no token": nothing at all
      expect(runState(cwd)).toEqual(before);
      expect(runState(cwd).goals).toEqual([]);
    });
  }

  test("the task-count ceiling leaves the same zero run state", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd, 1);
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**"]);
    const before = runState(cwd);
    expect(sddx(cwd, "plan", "start", rel).status).not.toBe(0);
    expect(runState(cwd)).toEqual(before);
  });

  test("the spec survives a blocker unchanged, so the plan can be inspected and refined", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/secrets/**"]);
    const before = readFileSync(join(cwd, rel), "utf8");
    expect(sddx(cwd, "plan", "start", rel).status).not.toBe(0);
    expect(existsSync(join(cwd, rel))).toBe(true);
    expect(readFileSync(join(cwd, rel), "utf8")).toBe(before);
  });

  test("a blocker never offers an approval as a way to continue", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/billing/**"]);
    const r = sddx(cwd, "plan", "start", rel);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).not.toContain("plan approve");
    expect(all).not.toContain("Approve");
    // and the remedy it DOES name is a reviewed-configuration edit, never a
    // flag or an environment variable the agent could compose for itself
    expect(all).toContain("interaction_mode");
    expect(all).not.toContain("--mode");
    expect(all).not.toContain("SDDX_INTERACTION_MODE");
  });

  test("and approving is refused outright, not merely unhelpful", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/credentials/**"]);
    const approve = sddx(cwd, "plan", "approve", rel);
    expect(approve.status).not.toBe(0);
    expect(runState(cwd).approvals).toEqual([]);
    // even with a token forced into place, starting still refuses: the bounds
    // are evaluated before the token is looked up
    writeApproval(cwd, { plan_sha256: planHash(join(cwd, rel)).hash, mode: "human" });
    const start = sddx(cwd, "plan", "start", rel);
    expect(start.status).not.toBe(0);
    expect(start.stderr).toContain("credentials");
    expect(runState(cwd).goals).toEqual([]);
  });
});

describe("the deterministic bound does not consult the self-report", () => {
  test("a protected-path plan blocks when the spec lists no open decisions", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["src/n0/**", "src/auth/**"]);
    expect(readFileSync(join(cwd, rel), "utf8")).toContain("### Open decisions\n\n## Tasks");
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auth");
  });
});

describe("auto mode is non-interactive end to end", () => {
  test("no command in the goal to completion path prompts, offers, or waits", () => {
    const { clone: cwd } = fixtureClone();
    auto(cwd);
    const rel = planRepo(cwd, ["n0.done", "n1.done"]);
    const outputs: string[] = [];
    const record = (from: string, ...args: string[]) => {
      const r = sddx(from, ...args);
      outputs.push(r.stdout, r.stderr);
      return r;
    };

    expect(record(cwd, "plan", "check", rel).status).toBe(0);
    const started = record(cwd, "plan", "start", rel, "--output", "json");
    expect(started.status).toBe(0);
    const goalId = JSON.parse(started.stdout).data.goalId as string;
    for (const id of ["n0", "n1"]) {
      const s = record(cwd, "task", "start", id, "--output", "json");
      expect(s.status).toBe(0);
      writeFileSync(join(JSON.parse(s.stdout).data.path as string, doneFile(id)), "done\n");
      expect(record(cwd, "verify", id).status).toBe(0);
      expect(
        record(cwd, "review", "record", id, "--verdict", "pass", "--reviewer", "test").status,
      ).toBe(0);
    }
    record(cwd, "board");
    expect(record(cwd, "run", "report", "--goal", goalId).stdout).toContain("Run completed");

    const all = outputs.join("\n");
    for (const prompt of ["Approve", "Regenerate", "[y/N]", "(y/n)", "Select ", "press "]) {
      expect(all).not.toContain(prompt);
    }
  }, 60_000);
});
