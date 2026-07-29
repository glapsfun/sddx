import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExamples, runExample } from "../scripts/verify-examples";
import { repoRoot } from "./helpers";

const EXPECTED = [
  "01-single-task",
  "02-parallel-run",
  "03-dag-dependencies",
  "04-retry-and-skip",
  "06-oracle-types",
  "07-receipts-and-audit",
  "08-pr-from-goal",
  "09-config-tuning",
];

describe("runnable examples", () => {
  test("every documented feature has a runnable example, none silently missing", () => {
    expect(discoverExamples(repoRoot)).toEqual(EXPECTED);
  });

  for (const name of EXPECTED) {
    // Explicit timeout: each example now replays a full canonical run — approve,
    // create, a worktree per root task — which is several seconds of real git
    // and CLI process work. Standalone they finish in 1.5-3s, but under the
    // whole suite's parallelism that crosses bun's 5s default and flakes. The
    // other process-spawning e2e suites here declare theirs for the same reason.
    test(`${name} runs exactly as documented`, () => {
      const target = mkdtempSync(join(tmpdir(), `sddx-example-${name}-`));
      const result = runExample(repoRoot, name, target);
      expect(result.ok, result.message).toBe(true);
    }, 30_000);
  }
});
