import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALWAYS_ON_BUDGET,
  frontmatterValue,
  measureAlwaysOn,
  measureRouter,
  ROUTER_BUDGET,
  renderReport,
} from "../scripts/token-budget";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";
import {
  AGENTS,
  agentTools,
  contractViolations,
  harnessToolsIn,
  knownCommands,
  MAPPING_FILE,
  namedCommands,
  SKILLS,
} from "./skill-contract";

const known = knownCommands();

/** A plugin root holding the given files, relative path to content. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "contract-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const skill = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: test skill\n---\n\n${body}\n`;

describe("reading commands out of skill text", () => {
  test("the CLI's usage gives single commands and command pairs", () => {
    for (const c of [
      "verify",
      "board",
      "plan check",
      "plan approve",
      "task phase",
      "review record",
    ]) {
      expect(known.has(c)).toBe(true);
    }
    expect(known.has("plan")).toBe(false);
  });

  test("commands are read from code spans and code blocks, never from prose", () => {
    const md = [
      "Route work through sddx in this repository, or run /sddx:brainstorm.",
      "Prove it with `sddx verify T1` and check `.sddx/tasks/` by hand never.",
      "```sh",
      "sddx plan check .sddx/specs/x.md && sddx plan approve .sddx/specs/x.md",
      "! sddx task start T1",
      "```",
    ].join("\n");
    expect(namedCommands(md, known)).toEqual([
      "plan check",
      "plan approve",
      "task start",
      "verify",
    ]);
  });

  test("a mapping file may name Claude Code tools; prose names of other tools are not flagged", () => {
    expect(harnessToolsIn("Use the Agent tool, then AskUserQuestion.")).toEqual([
      "Agent tool",
      "AskUserQuestion",
    ]);
    expect(harnessToolsIn("An agent, a task, a skill.")).toEqual([]);
    const root = fixture({ [MAPPING_FILE]: "Dispatch with the Agent tool and `subagent_type`.\n" });
    expect(contractViolations(root, known)).toEqual([]);
  });

  test("agent tools are read from a comma-separated value or a YAML list", () => {
    expect(agentTools("---\nname: a\ntools: Read, Grep, Bash\n---\n")).toEqual([
      "Read",
      "Grep",
      "Bash",
    ]);
    expect(agentTools("---\nname: a\ntools:\n  - Read\n  - Bash\n---\n")).toEqual(["Read", "Bash"]);
    expect(agentTools("---\nname: a\n---\n")).toBeNull();
  });
});

describe("contract violations in fixtures", () => {
  scenario("workflow-skills", "A removed command is caught", () => {
    const root = fixture({
      "skills/demo/SKILL.md": skill("demo", "Then run `sddx red-check T1`."),
    });
    const v = contractViolations(root, known);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(join("skills", "demo", "SKILL.md"));
    expect(v[0]).toContain("red-check");
  });

  scenario("workflow-skills", "Harness tool named in a skill body", () => {
    const root = fixture({
      "skills/demo/SKILL.md": skill("demo", "Ask with AskUserQuestion, one question at a time."),
    });
    const v = contractViolations(root, known);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(join("skills", "demo", "SKILL.md"));
    expect(v[0]).toContain("AskUserQuestion");
  });
});

const shipped = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("the shipped skills", () => {
  scenario("workflow-skills", "Gates named in order", () => {
    const gates: Record<string, string[]> = {
      brainstorm: ["spec check"],
      plan: ["plan check", "plan approve", "plan start"],
      execute: ["task start", "verify"],
      review: ["review record"],
      finish: ["audit", "pr create"],
    };
    for (const [name, expected] of Object.entries(gates)) {
      const named = namedCommands(shipped(join("skills", name, "SKILL.md")), known);
      for (const gate of expected)
        expect({ skill: name, named }).toMatchObject({ named: expect.arrayContaining([gate]) });
    }
    const plan = namedCommands(shipped(join("skills", "plan", "SKILL.md")), known);
    const first = (c: string): number => plan.indexOf(c);
    expect(first("plan check")).toBeLessThan(first("plan approve"));
    expect(first("plan approve")).toBeLessThan(first("plan start"));
  });
});

describe("the shipped agents", () => {
  scenario("workflow-skills", "Critic cannot write", () => {
    const tools = agentTools(shipped(join("agents", "critic.md")));
    expect(tools).not.toBeNull();
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent"]) {
      expect(tools).not.toContain(t);
    }
  });

  scenario("workflow-skills", "Worker cannot dispatch", () => {
    const tools = agentTools(shipped(join("agents", "worker.md")));
    expect(tools).not.toBeNull();
    expect(tools).not.toContain("Agent");
  });
});

describe("the shipped plugin as a whole", () => {
  scenario("workflow-skills", "Skills present and well formed", () => {
    const dirs = readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...SKILLS].sort());
    for (const name of SKILLS) {
      const md = shipped(join("skills", name, "SKILL.md"));
      expect(frontmatterValue(md, "name")).toBe(name);
      expect((frontmatterValue(md, "description") ?? "").length).toBeGreaterThan(0);
    }
    const agents = readdirSync(join(repoRoot, "agents")).sort();
    expect(agents).toEqual(AGENTS.map((a) => `${a}.md`).sort());
  });

  scenario("workflow-skills", "Shipped files pass", () => {
    expect(contractViolations(repoRoot, known)).toEqual([]);
  });

  scenario("workflow-skills", "Mapping file exempt", () => {
    expect(contractViolations(repoRoot, known)).toEqual([]);
    const naming = [...SKILLS.map((s) => join("skills", s, "SKILL.md")), MAPPING_FILE].filter(
      (f) => harnessToolsIn(shipped(f)).length > 0,
    );
    expect(naming).toEqual([MAPPING_FILE]);
  });

  scenario("workflow-skills", "Shipped files within budget", () => {
    const always = measureAlwaysOn(repoRoot);
    const router = measureRouter(repoRoot);
    console.log(`${renderReport("always-on", always)}\n\n${renderReport("router", router)}`);
    expect(always.items).toHaveLength(SKILLS.length + AGENTS.length);
    expect(always.total).toBeLessThanOrEqual(ALWAYS_ON_BUDGET);
    expect(router.total).toBeLessThanOrEqual(ROUTER_BUDGET);
  });
});
