import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentModel } from "../src/lib/config";
import { repoRoot } from "./helpers";

const AGENTS_DIR = join(repoRoot, "templates", "claude", "agents");
const ROLES = ["intake", "orchestrator", "planner", "tdd-executor", "verifier"];

/** Frontmatter of an agent definition, as Claude Code reads it. */
function frontmatter(role: string): Record<string, string> {
  const text = readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${role}.md has no frontmatter block`);
  const out: Record<string, string> = {};
  for (const line of (m[1] as string).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const body = (role: string) => readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");
const tools = (role: string) =>
  (frontmatter(role).tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

describe("agent definitions", () => {
  // The real gate is `claude plugin validate --strict` in CI, which needs the
  // pinned CLI. This asserts the structure that validation reads, so a missing
  // or malformed definition fails here rather than only on a push.
  test("the plugin ships exactly the five roles, and no stragglers", () => {
    expect(
      readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort(),
    ).toEqual(ROLES.map((r) => `${r}.md`).sort());
  });

  for (const role of ROLES) {
    test(`${role} declares valid frontmatter`, () => {
      const fm = frontmatter(role);
      expect(fm.name).toBe(role);
      expect(fm.description ?? "").not.toBe("");
      expect(tools(role).length).toBeGreaterThan(0);
    });
  }

  test("intake may draft but never build: no Edit, no Bash, no Task", () => {
    expect(tools("intake")).toContain("Write");
    expect(tools("intake")).not.toContain("Edit");
    expect(tools("intake")).not.toContain("Bash");
    expect(tools("intake")).not.toContain("Task");
  });

  test("intake's body forbids every write that is not the brief header", () => {
    // frontmatter cannot express path-level limits, so the body has to
    const b = body("intake").toLowerCase();
    for (const forbidden of ["tasks:", "goal", "branch", "worktree", "source"]) {
      expect(b).toContain(forbidden);
    }
    expect(b).toContain("never");
  });

  test("intake returns its questions rather than asking them", () => {
    // a subagent has no channel to the user; asking directly would deadlock
    expect(body("intake").toLowerCase()).toContain("return");
    expect(tools("intake")).not.toContain("AskUserQuestion");
  });

  test("tdd-executor can build but not dispatch", () => {
    const t = tools("tdd-executor");
    expect(t).toContain("Edit");
    expect(t).toContain("Write");
    expect(t).toContain("Bash");
    expect(t).not.toContain("Task");
  });

  test("verifier is read-and-run only", () => {
    expect(tools("verifier").sort()).toEqual(["Bash", "Read"]);
  });

  // Retiring the per-task action catalog removed the menu's implementation
  // without forbidding a role from asking for one.
  test("no role emits a per-task handoff menu", () => {
    for (const role of ROLES) {
      for (const line of body(role).split("\n")) {
        if (!line.includes("next-actions")) continue;
        // the one legal menu is goal-scoped, shown once after the run summary
        expect(line).toContain("--goal");
      }
    }
  });

  test("the verifier in particular offers nothing on completion", () => {
    expect(body("verifier")).not.toContain("next-actions");
  });
});

describe("agent_model roles", () => {
  test("intake is a configurable role alongside the other four", () => {
    const { models, warnings } = parseAgentModel("intake=haiku,planner=opus");
    expect(warnings).toEqual([]);
    expect(models.intake).toBe("haiku");
  });
});

describe("the run skill's intake round", () => {
  const skill = readFileSync(
    join(repoRoot, "templates", "claude", "skills", "run", "SKILL.md"),
    "utf8",
  );

  test("dispatches intake before the orchestrator", () => {
    expect(skill.indexOf("`intake` agent")).toBeGreaterThan(-1);
    expect(skill.indexOf("`intake` agent")).toBeLessThan(skill.indexOf("`orchestrator` agent"));
  });

  test("states that a subagent cannot prompt the user, so the session renders the batch", () => {
    expect(skill).toContain("no channel to the user");
    expect(skill).toContain("intake check --batch");
  });

  test("forbids a second question round short of a goal change", () => {
    // the rule this flow exists to hold: one cold subagent per goal, not one
    // per round of questions
    expect(skill).toContain("Do not re-dispatch intake");
    expect(skill).toContain("changing the goal itself");
  });

  test("Regenerate truncates to the header rather than discarding answers", () => {
    expect(skill).toContain("graph regenerate --graph");
    expect(skill).toContain("truncates the draft back to its");
    expect(skill).toContain("no question is re-asked");
  });

  test("the orchestrator appends tasks: rather than authoring the file", () => {
    expect(skill).toContain("appends `tasks:`");
    expect(skill).toContain("never restarting requirements discovery");
  });
});

describe("the header's two other readers", () => {
  test("the orchestrator appends to the header and never re-interviews", () => {
    const b = body("orchestrator");
    expect(b).toContain("append `tasks:`");
    expect(b).toContain("do not restart requirements discovery");
    // an open question is reported back, never asked — no channel to the user
    expect(b).toContain("Ask the user a question");
    expect(b).toContain("no channel to the user");
  });

  test("the planner consumes the header and reports missing proof instead of editing it", () => {
    const b = body("planner");
    expect(b).toContain("Goal Brief header");
    expect(b).toContain("report that back to the orchestrator");
    expect(b).toContain("Edit the graph file");
  });
});

describe("intake in auto mode", () => {
  const b = body("intake");

  test("asks nothing and records conservative defaults as assumptions with rationale", () => {
    expect(b).toContain("Ask nothing — nobody is there");
    expect(b).toContain("record it in `assumptions` with its rationale");
  });

  test("reports what it could not decide instead of guessing past it", () => {
    expect(b).toContain("`unresolved`");
    expect(b).toContain("refuses the run rather than degrading it to a prompt");
  });

  test("is told that emptying unresolved buys nothing", () => {
    // the self-report is additive; the deterministic bounds do not consult it,
    // so there is no incentive to under-report
    expect(b).toContain("Do not empty the list");
    expect(b).toContain("independently of anything you report");
  });
});

describe("the plan skill's plan-only behavior", () => {
  const skill = readFileSync(
    join(repoRoot, "templates", "claude", "skills", "plan", "SKILL.md"),
    "utf8",
  );

  test("human may approve for a later run without creating anything", () => {
    expect(skill).toContain("graph approve --graph <path>` records a token");
    expect(skill).toContain("still creates nothing");
    expect(skill).toContain("unchanged* draft");
  });

  test("auto plans without prompting and writes no token", () => {
    expect(skill).toContain("Ask\n  nothing and wait for nothing");
    expect(skill).toContain("Do not write an approval token");
  });

  test("names the one round and the three-question cap for human mode", () => {
    expect(skill).toContain("one** round of at most three questions");
  });
});
