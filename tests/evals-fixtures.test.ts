// Every eval fixture builds the end state its scenarios start from, checked
// through the CLI the way a grader would see it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, type FixtureContext, GOAL, SPEC, TASK } from "../evals/fixtures";
import type { Mode } from "../evals/types";
import { goalIds, repoRoot, sddx } from "./helpers";

function build(name: string, mode: Mode = "human") {
  const dir = mkdtempSync(join(tmpdir(), `sddx-evals-fx-${name}-`));
  const ctx: FixtureContext = {
    sddx: (cwd, ...args) => {
      const r = sddx(cwd, ...args);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    mode,
    v5Archive: join(repoRoot, "tests", "fixtures", "v5-repo.tar.gz"),
  };
  const builder = FIXTURES[name];
  if (!builder) throw new Error(`no fixture ${name}`);
  return { dir, info: builder(dir, ctx) };
}

const taskPhase = (dir: string): string =>
  JSON.parse(sddx(dir, "task", "show", TASK, "--output", "json").stdout).data.phase;

const config = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".sddx", "config.json"), "utf8")) as Record<string, unknown>;

describe("eval fixtures", () => {
  test("plain: the greeter project with its typo and no .sddx/", () => {
    const { dir } = build("plain");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Helo");
    expect(existsSync(join(dir, ".sddx"))).toBe(false);
    expect(spawnSync("bun", ["test"], { cwd: dir }).status).toBe(0);
  });

  test("opted-in: a committed config in the scenario's mode", () => {
    for (const mode of ["human", "auto"] as const) {
      const { dir } = build("opted-in", mode);
      expect(config(dir).interaction_mode).toBe(mode);
      expect(
        spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout,
      ).toBe("");
    }
  }, 30_000);

  test("design-only: a committed spec with a Design and no Tasks", () => {
    const { dir, info } = build("design-only");
    expect(info.spec).toBe(SPEC);
    expect(readFileSync(join(dir, SPEC), "utf8")).not.toContain("## Tasks");
    expect(sddx(dir, "spec", "check", SPEC).status).toBe(0);
  });

  test("approval-pending: a plan that checks, with no approval and no goal", () => {
    const { dir } = build("approval-pending");
    expect(sddx(dir, "plan", "check", SPEC).status).toBe(0);
    expect(existsSync(join(dir, ".sddx", "approvals"))).toBe(false);
    expect(goalIds(dir)).toEqual([]);
  });

  test("planned-goal: the goal started by the user, its task PLANNED", () => {
    const { dir, info } = build("planned-goal");
    expect(info).toEqual({ spec: SPEC, goal: GOAL, task: TASK });
    expect(goalIds(dir)).toEqual([GOAL]);
    expect(taskPhase(dir)).toBe("PLANNED");
  });

  test("strict-goal: the same, in the strict profile", () => {
    const { dir } = build("strict-goal");
    expect(config(dir).profile).toBe("strict");
    expect(taskPhase(dir)).toBe("PLANNED");
  });

  test("in-review: the task verified and waiting for review", () => {
    const { dir } = build("in-review");
    const t = JSON.parse(sddx(dir, "task", "show", TASK, "--output", "json").stdout).data;
    expect(t.phase).toBe("IN_REVIEW");
    expect(t.verified).toBeDefined();
  });

  test("v5: the sddx 5 repository with its leftovers", () => {
    const { dir } = build("v5");
    expect(String(config(dir).schema_version)).toStartWith("1.");
    expect(sddx(dir, "doctor").stdout + sddx(dir, "doctor").stderr).toContain("migrate");
  });
});
