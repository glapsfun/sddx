// A whole goal driven through the CLI with no harness and no LLM, the way an
// orchestrator would: the proof that every v6 guarantee holds from L1 alone.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/lib/receipt";
import { fixtureRepo, writeConfig } from "./fixtures";
import { goalSpec, readTaskState, sddx, writeSpec } from "./helpers";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
const ok = (r: { status: number | null; stdout: string; stderr: string }) => {
  if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
};
const json = (r: { stdout: string }) => JSON.parse(r.stdout).data;

const GOAL = "2026-10-26-greeting";

/** A three-task goal: two independent roots and a fan-in child, each with a real bun test. */
function greetingSpec(): string {
  return [
    "# Greeting service",
    "",
    "## Design",
    "",
    "### Goal",
    "Greet people by name, politely.",
    "",
    "### Acceptance",
    '- greet("Ada") returns "Hello, Ada"',
    '- polite("Hello, Ada") returns "Hello, Ada, please."',
    "",
    "### Non-goals",
    "- translations",
    "",
    "### Assumptions",
    "- one module per concern",
    "",
    "### Open decisions",
    "",
    "## Tasks",
    "",
    "### g-greet Greeting",
    "",
    "```sddx",
    "oracle: {type: command, run: bun test tests/greet.test.ts, expect: exit 0}",
    "scope: [src/greet.ts]",
    "```",
    "",
    "### g-polite Politeness",
    "",
    "```sddx",
    "oracle: {type: command, run: bun test tests/polite.test.ts, expect: exit 0}",
    "scope: [src/polite.ts]",
    "```",
    "",
    "### g-both Polite greeting",
    "",
    "```sddx",
    "oracle: {type: test-suite, run: bun test tests/both.test.ts, expect: exit 0, runs: 2}",
    "scope: [src/both.ts]",
    "depends_on: [g-greet, g-polite]",
    "```",
    "",
  ].join("\n");
}

const FILES: Record<string, Record<string, string>> = {
  "g-greet": {
    "tests/greet.test.ts":
      'import { expect, test } from "bun:test";\nimport { greet } from "../src/greet";\ntest("greet", () => expect(greet("Ada")).toBe("Hello, Ada"));\n',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text written to a file
    "src/greet.ts": "export const greet = (name: string): string => `Hello, ${name}`;\n",
  },
  "g-polite": {
    "tests/polite.test.ts":
      'import { expect, test } from "bun:test";\nimport { polite } from "../src/polite";\ntest("polite", () => expect(polite("Hello, Ada")).toBe("Hello, Ada, please."));\n',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text written to a file
    "src/polite.ts": "export const polite = (s: string): string => `${s}, please.`;\n",
  },
  "g-both": {
    "tests/both.test.ts":
      'import { expect, test } from "bun:test";\nimport { politeGreet } from "../src/both";\ntest("both", () => expect(politeGreet("Ada")).toBe("Hello, Ada, please."));\n',
    "src/both.ts":
      'import { greet } from "./greet";\nimport { polite } from "./polite";\nexport const politeGreet = (n: string): string => polite(greet(n));\n',
  },
};

function implement(worktree: string, id: string, only?: "tests"): void {
  for (const [path, content] of Object.entries(FILES[id] ?? {})) {
    if (only === "tests" && !path.startsWith("tests/")) continue;
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
}

describe("a three-task fan-in goal, end to end", () => {
  test("spec to merged run branch with an auditable receipt chain", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, GOAL, greetingSpec());

    expect(json(ok(sddx(cwd, "spec", "check", spec, "--output", "json"))).status).toBe("ready");
    const check = json(ok(sddx(cwd, "plan", "check", spec, "--output", "json")));
    expect(check.taskCount).toBe(3);
    expect(check.approved).toBe(false);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(3);
    ok(sddx(cwd, "plan", "approve", spec, "--harness", "e2e"));
    const started = json(ok(sddx(cwd, "plan", "start", spec, "--output", "json")));
    expect(started.taskIds).toEqual(["g-greet", "g-polite", "g-both"]);

    expect(json(ok(sddx(cwd, "task", "ready", "--goal", GOAL, "--output", "json"))).ready).toEqual([
      "g-greet",
      "g-polite",
    ]);
    const roots = ["g-greet", "g-polite"].map((id) => {
      const wt = json(ok(sddx(cwd, "task", "start", id, "--output", "json"))).path as string;
      implement(wt, id, "tests");
      // tests alone: GREEN must fail, so verify refuses
      expect(sddx(cwd, "verify", id).status).toBe(1);
      implement(wt, id);
      return wt;
    });
    for (const id of ["g-greet", "g-polite"]) ok(sddx(cwd, "verify", id));
    for (const id of ["g-greet", "g-polite"]) {
      ok(
        sddx(
          cwd,
          "review",
          "record",
          id,
          "--verdict",
          "pass",
          "--reviewer",
          "critic",
          "--harness",
          "e2e",
        ),
      );
    }

    expect(json(ok(sddx(cwd, "task", "ready", "--goal", GOAL, "--output", "json"))).ready).toEqual([
      "g-both",
    ]);
    const both = json(ok(sddx(cwd, "task", "start", "g-both", "--output", "json"))).path as string;
    implement(both, "g-both");
    ok(sddx(cwd, "verify", "g-both"));
    const review = sddx(
      cwd,
      "review",
      "record",
      "g-both",
      "--verdict",
      "fail",
      "--findings",
      join(roots[0] as string, "src", "greet.ts"),
    );
    expect(review.status).toBe(0);
    expect(readTaskState(cwd, "g-both").phase).toBe("IN_PROGRESS");
    ok(sddx(cwd, "verify", "g-both"));
    ok(sddx(cwd, "review", "record", "g-both", "--verdict", "pass", "--reviewer", "critic"));

    const report = json(ok(sddx(cwd, "run", "report", "--goal", GOAL, "--output", "json")));
    expect(report.merged).toBe(3);
    expect(report.total).toBe(3);
    expect(sddx(cwd, "run", "report", "--goal", GOAL).stdout).toContain("Run completed");

    // The run branch holds the plan commit, every task and every receipt.
    const run = `sddx/run-${GOAL}`;
    const tree = git(cwd, "ls-tree", "-r", "--name-only", run).split("\n");
    for (const f of ["src/both.ts", "src/greet.ts", "src/polite.ts", spec])
      expect(tree).toContain(f);
    for (const id of ["g-greet", "g-polite", "g-both"])
      expect(tree).toContain(`.sddx/receipts/${id}.json`);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(git(cwd, "rev-parse", "main"));

    // Merging the run branch is the person's call; once they do, audit reads the whole chain.
    git(cwd, "merge", "-q", "--no-ff", "-m", "merge greeting", run);
    const audit = ok(sddx(cwd, "audit"));
    expect(audit.stdout).toContain("3 receipt(s) verified, chain intact");
    expect(audit.stdout).toContain("human approval not provable");
    expect(audit.stdout).toContain("harness e2e (reported, not verified)");
    const both5 = JSON.parse(readFileSync(join(cwd, ".sddx", "receipts", "g-both.json"), "utf8"));
    expect(both5.runs).toHaveLength(2);
    // receipts form a hash tree: the parallel roots are siblings at seq 1, and
    // the fan-in child chains onto one of them
    const rootHashes = ["g-greet", "g-polite"].map((id) =>
      sha256(readFileSync(join(cwd, ".sddx", "receipts", `${id}.json`))),
    );
    expect(both5.seq).toBe(2);
    expect(rootHashes).toContain(both5.prev);
  });
});

describe("negative paths stop the goal where they should", () => {
  test("an oracle that passes without the change never reaches review", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, GOAL, goalSpec({ tasks: [{ id: "T1", run: "true" }] }));
    ok(sddx(cwd, "plan", "approve", spec));
    ok(sddx(cwd, "plan", "start", spec));
    ok(sddx(cwd, "task", "start", "T1"));
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("passes without the change");
  });

  test("work changed after verify cannot be reviewed into the run branch", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, GOAL, goalSpec({ tasks: [{ id: "T1" }] }));
    ok(sddx(cwd, "plan", "approve", spec));
    ok(sddx(cwd, "plan", "start", spec));
    const wt = json(ok(sddx(cwd, "task", "start", "T1", "--output", "json"))).path as string;
    const runHead = git(cwd, "rev-parse", `sddx/run-${GOAL}`);
    writeFileSync(join(wt, "T1.done"), "done\n");
    ok(sddx(cwd, "verify", "T1"));
    writeFileSync(join(wt, "T1.done"), "sneaked in\n");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(1);
    expect(git(cwd, "rev-parse", `sddx/run-${GOAL}`)).toBe(runHead);
  });

  test("open decisions keep a plan from being approved or started", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      GOAL,
      goalSpec({ tasks: [{ id: "T1" }], openDecisions: ["which db"] }),
    );
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(1);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(1);
  });

  test("an unapproved plan starts nothing", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, GOAL, goalSpec({ tasks: [{ id: "T1" }] }));
    expect(sddx(cwd, "plan", "start", spec).status).toBe(3);
    expect(git(cwd, "branch", "--list", "sddx/*")).toBe("");
  });

  test("an abandoned root skips its dependent and the rest of the goal finishes", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      GOAL,
      goalSpec({ tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }, { id: "T3" }] }),
    );
    ok(sddx(cwd, "plan", "approve", spec));
    ok(sddx(cwd, "plan", "start", spec));
    ok(sddx(cwd, "task", "start", "T1"));
    ok(sddx(cwd, "task", "abandon", "T1", "--reason", "wrong approach"));
    const wt = json(ok(sddx(cwd, "task", "start", "T3", "--output", "json"))).path as string;
    writeFileSync(join(wt, "T3.done"), "done\n");
    ok(sddx(cwd, "verify", "T3"));
    ok(sddx(cwd, "review", "record", "T3", "--verdict", "pass"));
    const report = json(ok(sddx(cwd, "run", "report", "--goal", GOAL, "--output", "json")));
    expect(report).toMatchObject({ merged: 1, failed: 1, skipped: 1, total: 3 });
  });

  test("a task started under strict cannot be verified after the profile changes", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    const spec = writeSpec(cwd, GOAL, goalSpec({ tasks: [{ id: "T1" }] }));
    ok(sddx(cwd, "plan", "approve", spec));
    ok(sddx(cwd, "plan", "start", spec));
    ok(sddx(cwd, "task", "start", "T1"));
    writeConfig(cwd, { interaction_mode: "human", profile: "default" });
    expect(sddx(cwd, "verify", "T1").stderr).toContain("started under the strict profile");
  });
});
