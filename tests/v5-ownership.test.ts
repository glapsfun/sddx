import { describe, expect, test } from "bun:test";
import { V5_OWNED } from "../src/lib/legacy/v5-claude";

// The table was generated from the sddx 5.0.0 Claude adapter before it was
// removed. Content varied only with the embedded invocation, so a file is owned
// by one hash when its template had no `{{SDDX}}` placeholder and three when it did.
const PLACEHOLDER_FREE = new Set([
  ".claude/agents/sddx-intake.md",
  ".claude/agents/sddx-planner.md",
]);
const EXPECTED = [
  ".claude/agents/sddx-intake.md",
  ".claude/agents/sddx-orchestrator.md",
  ".claude/agents/sddx-planner.md",
  ".claude/agents/sddx-tdd-executor.md",
  ".claude/agents/sddx-verifier.md",
  ".claude/skills/sddx-audit/SKILL.md",
  ".claude/skills/sddx-board/SKILL.md",
  ".claude/skills/sddx-plan/SKILL.md",
  ".claude/skills/sddx-pr/SKILL.md",
  ".claude/skills/sddx-run/SKILL.md",
  ".claude/skills/sddx-verify/SKILL.md",
];

describe("frozen v5 ownership table", () => {
  test("covers every file sddx 5.0.0 generated into .claude/", () => {
    expect(Object.keys(V5_OWNED).sort()).toEqual(EXPECTED);
  });

  test("holds one hash per distinct invocation form", () => {
    for (const path of EXPECTED) {
      expect(V5_OWNED[path]).toHaveLength(PLACEHOLDER_FREE.has(path) ? 1 : 3);
      for (const h of V5_OWNED[path] ?? []) expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
