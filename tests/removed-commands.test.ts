import { describe, expect, test } from "bun:test";
import { fixtureRepo } from "./fixtures";
import { sddx } from "./helpers";

// Each sddx 5 command that sddx 6 removed exits 2 and names what replaces it,
// rather than falling through to a usage dump.
const REMOVED: Array<{ args: string[]; replacement: string }> = [
  { args: ["init", "--yes"], replacement: "plugin" },
  { args: ["sync", "--adapter", "claude"], replacement: "plugin" },
  { args: ["uninstall", "--adapter", "claude"], replacement: "sddx migrate" },
  { args: ["graph", "create", "--graph", "g.yaml"], replacement: "sddx plan start" },
  { args: ["graph", "approve", "--graph", "g.yaml"], replacement: "sddx plan approve" },
  { args: ["graph", "regenerate", "--graph", "g.yaml"], replacement: "sddx plan check" },
  { args: ["graph", "cancel", "--graph", "g.yaml"], replacement: "sddx plan check" },
  { args: ["intake", "check", "--batch", "q.yaml"], replacement: "sddx spec check" },
  { args: ["red-check", "T1"], replacement: "sddx verify" },
  { args: ["task", "materialize", "T1"], replacement: "sddx task start" },
  { args: ["task", "create", "--spec", "s.yaml"], replacement: "sddx plan start" },
  { args: ["goal", "create", "--goal", "g"], replacement: "sddx plan start" },
];

describe("removed commands", () => {
  for (const { args, replacement } of REMOVED) {
    test(`sddx ${args.slice(0, 2).join(" ")} exits 2 naming ${replacement}`, () => {
      const r = sddx(fixtureRepo(), ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(replacement);
    });
  }
});
