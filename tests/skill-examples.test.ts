// The example specs the brainstorm and plan skills show the agent must be specs
// the CLI accepts: an agent copies the shape of what it is shown.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRepo } from "./fixtures";
import { CLI, commitSpec, completeTask, createRun, repoRoot, sddx } from "./helpers";
import { scenario } from "./scenario";

/** Every ````markdown block that follows a `<!-- spec-example -->` marker. */
function examples(skill: string): string[] {
  const text = readFileSync(join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
  return [...text.matchAll(/<!-- spec-example -->\n````markdown\n([\s\S]*?)\n````/g)].map(
    (m) => `${m[1]}\n`,
  );
}

function specInRepo(text: string): { cwd: string; rel: string } {
  const cwd = fixtureRepo();
  mkdirSync(join(cwd, ".sddx", "specs"), { recursive: true });
  const rel = join(".sddx", "specs", "2026-01-01-example.md");
  writeFileSync(join(cwd, rel), text);
  return { cwd, rel };
}

describe("example specs in the skills", () => {
  test("brainstorm's design passes sddx spec check as ready", () => {
    const found = examples("brainstorm");
    expect(found).toHaveLength(1);
    const { cwd, rel } = specInRepo(found[0] as string);
    const r = sddx(cwd, "spec", "check", rel, "--output", "json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).data.status).toBe("ready");
  });

  test("plan's full spec passes sddx plan check", () => {
    const found = examples("plan");
    expect(found).toHaveLength(1);
    const { cwd, rel } = specInRepo(found[0] as string);
    commitSpec(cwd, rel); // the skill commits before plan check, as the CLI requires
    const r = sddx(cwd, "plan", "check", rel, "--output", "json");
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    expect(JSON.parse(r.stdout).data.taskCount).toBeGreaterThan(1);
  });
});

describe("finish audits where the goal's receipts are", () => {
  scenario(
    "workflow-skills",
    "Finish's audit sees the goal's receipts",
    () => {
      const text = readFileSync(join(repoRoot, "skills", "finish", "SKILL.md"), "utf8");
      const block = /```sh\n([\s\S]*?)```/.exec(text)?.[1];
      expect(block).toBeDefined();

      const cwd = fixtureRepo();
      const run = createRun(cwd, { tasks: [{ id: "T1" }] });
      completeTask(cwd, "T1");
      // the agent's `sddx`, here the CLI from this checkout
      const bin = mkdtempSync(join(tmpdir(), "sddx-bin-"));
      writeFileSync(join(bin, "sddx"), `#!/bin/sh\nexec bun ${CLI} "$@"\n`);
      chmodSync(join(bin, "sddx"), 0o755);
      const r = spawnSync("sh", ["-c", (block as string).replaceAll("<goal-id>", run.goalId)], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1" },
      });
      if (r.status !== 0) throw new Error(r.stdout + r.stderr);
      expect(r.stdout).toContain("audit: 1 receipt(s) verified, chain intact");
      const worktrees = spawnSync("git", ["worktree", "list"], { cwd, encoding: "utf8" }).stdout;
      expect(worktrees).not.toContain("/run ");
      expect(worktrees.trim().split("\n")).toHaveLength(2); // the checkout and T1's worktree
    },
    60_000,
  );
});
