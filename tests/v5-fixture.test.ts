import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { extractV5Fixture } from "./v5-fixture";

const CLI = join(repoRoot, "src/cli.ts");

describe("v5 repository fixture", () => {
  test("holds a DONE task with a v4 receipt and a task left in RED", () => {
    const { dir, ids } = extractV5Fixture();
    const receipt = JSON.parse(
      readFileSync(join(dir, ".sddx", "receipts", `${ids.doneTaskId}.json`), "utf8"),
    );
    expect(receipt.version).toBe(4);
    const red = JSON.parse(
      readFileSync(
        join(dir, ".sddx-worktrees", ids.redTaskId, ".sddx", "tasks", `${ids.redTaskId}.json`),
        "utf8",
      ),
    );
    expect(red.phase).toBe("RED");
    expect(existsSync(join(dir, ".claude", "skills", "sddx-run", "SKILL.md"))).toBe(true);
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("echo user-hook");
    expect(settings).toContain("sddx hook tdd-gate");
  });

  test("its receipts pass sddx audit", () => {
    const { dir } = extractV5Fixture();
    const r = spawnSync("bun", [CLI, "audit"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("chain intact");
  });
});
