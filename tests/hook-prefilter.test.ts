// The launcher passes an approval-gate event through without starting Bun
// unless its payload contains sddx, cli.mjs or cli.ts. That is only safe if the
// handler would have passed every such event too. This runs the approval
// gate's own test corpus, as commands and as file paths, through both.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalGate } from "../src/lib/approvalgate";
import { repoRoot } from "./helpers";
import { runLauncher } from "./hook-launcher";

/** Every plain string literal in a source file, without template substitutions. */
function literals(file: string): string[] {
  const text = readFileSync(join(repoRoot, "tests", file), "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(["'\\])/g, "$1");
    if (s.trim().length > 1) out.add(s);
  }
  return [...out];
}

const corpus = [
  ...literals("approval-gate.test.ts"),
  ...literals("approval-bypass.test.ts"),
  "bun src/cli.ts plan approve plan.md",
  "node dist/cli.mjs plan start plan.md",
  "sh -c 'bun src/cli.ts plan start p.md'",
  "../approvals/x.json",
  "../config.json",
  // pieces the shell joins into one word: the raw payload never spells sddx
  's"d"dx plan approve spec.md',
  "sd''dx plan start p.md",
  "s\\ddx plan approve x",
  "s'ddx' plan approve .s'ddx'/specs/x.md",
  "SDDX plan start p.md",
  "sd\\\ndx plan approve x",
  'bun "src/cli".ts plan approve x',
];

/** A working directory whose own path names nothing the pre-filter looks for. */
const plainCwd = mkdtempSync(join(tmpdir(), "prefilter-"));
/** One inside .sddx/, where a relative path can reach the protected files. */
const insideSddx = join(mkdtempSync(join(tmpdir(), "prefilter-")), ".sddx", "tasks");
mkdirSync(insideSddx, { recursive: true });

describe("the approval pre-filter never skips an event the handler acts on", () => {
  test("the corpus is substantial", () => {
    expect(corpus.length).toBeGreaterThan(100);
  });

  for (const cwd of [plainCwd, insideSddx]) {
    test(`commands and file paths with working directory ${cwd === plainCwd ? "outside" : "inside"} .sddx/`, () => {
      const skippedButActedOn: string[] = [];
      for (const s of corpus) {
        const events = [
          {
            event: { tool_name: "Bash", tool_input: { command: s }, cwd },
            direct: () => approvalGate({ command: s, cwd }).decision,
          },
          {
            event: { tool_name: "Write", tool_input: { file_path: s, content: "" }, cwd },
            direct: () => approvalGate({ filePath: s, cwd }).decision,
          },
        ];
        for (const { event, direct } of events) {
          const r = runLauncher("approval-gate", event, { cwd: plainCwd, bun: { stdout: "{}" } });
          if (r.bunCalls.length > 0) continue; // the real handler decides; nothing to compare
          if (direct() !== "pass") skippedButActedOn.push(`${event.tool_name}: ${s}`);
        }
      }
      expect(skippedButActedOn).toEqual([]);
    }, 120_000);
  }
});
