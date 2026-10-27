import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_PATH } from "../scripts/make-v5-fixture";
import { repoRoot } from "./helpers";

export interface V5FixtureIds {
  goalId: string;
  doneTaskId: string;
  redTaskId: string;
}

/** Extracts the sddx 5.0.0 repository snapshot to a fresh directory and
 * re-links its worktrees, which recorded absolute paths when it was built. */
export function extractV5Fixture(): { dir: string; ids: V5FixtureIds } {
  const dir = mkdtempSync(join(tmpdir(), "sddx-v5-fixture-"));
  const untar = spawnSync("tar", ["-xzf", join(repoRoot, FIXTURE_PATH), "-C", dir]);
  if (untar.status !== 0) throw new Error(`tar -xzf failed: ${untar.stderr}`);
  const worktrees = readdirSync(join(dir, ".sddx-worktrees")).map((n) =>
    join(dir, ".sddx-worktrees", n),
  );
  const repair = spawnSync("git", ["worktree", "repair", ...worktrees], {
    cwd: dir,
    encoding: "utf8",
  });
  if (repair.status !== 0) throw new Error(`git worktree repair failed: ${repair.stderr}`);
  const ids = JSON.parse(
    readFileSync(join(dir, ".sddx", "local", "fixture-ids.json"), "utf8"),
  ) as V5FixtureIds;
  return { dir, ids };
}
