import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGoalSpec } from "../src/lib/goalspec";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

const CLI = join(repoRoot, "src/cli.ts");

const DESIGN = [
  "## Design",
  "",
  "### Goal",
  "Limit requests per client.",
  "",
  "### Acceptance",
  "- 429 after 100 requests per minute",
  "",
  "### Non-goals",
  "- distributed counters",
  "",
  "### Assumptions",
  "- in-memory counters are enough",
  "",
  "### Open decisions",
  "",
].join("\n");

const BLOCK = (body: string): string => ["```sddx", body, "```"].join("\n");

const ORACLE = [
  "oracle:",
  "  type: command",
  "  run: bun test tests/rl.test.ts",
  "  expect: exit 0",
].join("\n");

const TASK = (id: string, title: string, body = ORACLE): string =>
  [`### ${id} ${title}`, "", BLOCK(body), ""].join("\n");

const specWith = (design = DESIGN, tasks = ""): string =>
  ["# Rate limiting", "", design, tasks ? `## Tasks\n\n${tasks}` : ""].join("\n");

function writeSpec(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "sddx-goalspec-"));
  mkdirSync(join(dir, ".sddx", "specs"), { recursive: true });
  const file = join(".sddx", "specs", "2026-10-26-rate-limit.md");
  writeFileSync(join(dir, file), text);
  return { dir, file };
}

function check(text: string, ...extra: string[]) {
  const { dir, file } = writeSpec(text);
  const r = spawnSync("bun", [CLI, "spec", "check", file, ...extra], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("goal spec scanner", () => {
  test("headings inside fences are not headings", () => {
    const text = specWith(
      DESIGN,
      TASK("T1", "Bucket", `${ORACLE}\n# not a heading\n### T9 not a task`),
    );
    const { spec, errors } = parseGoalSpec(text);
    expect(errors).toEqual([]);
    expect(spec?.tasks.map((t) => t.id)).toEqual(["T1"]);
  });

  test("tilde fences and longer backtick fences are recognized", () => {
    const tilde = ["### T1 Bucket", "", "~~~sddx", ORACLE, "~~~", ""].join("\n");
    expect(parseGoalSpec(specWith(DESIGN, tilde)).spec?.tasks).toHaveLength(1);
    const long = ["### T1 Bucket", "", "````sddx", ORACLE, "```", "still inside", "````", ""].join(
      "\n",
    );
    expect(parseGoalSpec(specWith(DESIGN, long)).errors[0]?.message).toContain("invalid YAML");
  });

  test("an unclosed fence is an error with its line", () => {
    const text = specWith(DESIGN, ["### T1 Bucket", "", "```sddx", ORACLE].join("\n"));
    const err = parseGoalSpec(text).errors.find((e) => e.message.includes("never closed"));
    expect(err?.line).toBeGreaterThan(0);
  });

  test("CRLF line endings parse the same", () => {
    const text = specWith(DESIGN, TASK("T1", "Bucket")).replace(/\n/g, "\r\n");
    expect(parseGoalSpec(text).spec?.tasks).toHaveLength(1);
  });

  test("ordered and starred list items count as items", () => {
    const design = DESIGN.replace(
      "- 429 after 100 requests per minute",
      "1. first criterion\n* second criterion",
    );
    expect(parseGoalSpec(specWith(design)).spec?.design.acceptance).toEqual([
      "first criterion",
      "second criterion",
    ]);
  });

  test("dependencies accept a scalar or a list", () => {
    const tasks =
      TASK("T1", "One") +
      TASK("T2", "Two", `${ORACLE}\ndepends_on: T1`) +
      TASK("T3", "Three", `${ORACLE}\ndepends_on: [T1, T2]`);
    const spec = parseGoalSpec(specWith(DESIGN, tasks)).spec;
    expect(spec?.tasks.map((t) => t.depends_on)).toEqual([[], ["T1"], ["T1", "T2"]]);
  });
});

describe("task block validation", () => {
  const errorsFor = (body: string): string[] =>
    parseGoalSpec(specWith(DESIGN, TASK("T1", "Bucket", body))).errors.map((e) => e.message);

  test("rejects a non-integer or zero runs count", () => {
    expect(errorsFor(`${ORACLE}\n  runs: 0`)).toContain(
      "task T1: oracle.runs: must be an integer >= 1",
    );
    expect(errorsFor(`${ORACLE}\n  runs: 1.5`)).toContain(
      "task T1: oracle.runs: must be an integer >= 1",
    );
  });

  test("rejects an empty scope list and an empty assumptions list", () => {
    expect(errorsFor(`${ORACLE}\nscope: []`)[0]).toContain("scope: when present");
    expect(errorsFor(`${ORACLE}\nassumptions: []`)[0]).toContain("assumptions: when present");
  });

  test("validates the dependency failure policy and retry shape", () => {
    expect(errorsFor(`${ORACLE}\non_dependency_failure: ignore`)[0]).toContain(
      "on_dependency_failure",
    );
    expect(errorsFor(`${ORACLE}\nretry: {max_attempts: 0}`)[0]).toContain("retry.max_attempts");
    expect(errorsFor(`${ORACLE}\nretry: {workspace: keep}`)[0]).toContain("retry.workspace");
  });

  test("a manual oracle needs neither run nor expect", () => {
    expect(errorsFor("oracle:\n  type: manual")).toEqual([]);
  });

  test("unknown oracle keys are rejected", () => {
    expect(errorsFor(`${ORACLE}\n  retries: 2`)).toContain(
      'task T1: oracle: unknown key "retries"',
    );
  });

  test("valid optional keys are carried through", () => {
    const body = `${ORACLE}\nscope: [src/rl/**]\non_dependency_failure: block\nretry: {max_attempts: 2, workspace: reuse}\nassumptions: [redis is not needed]`;
    const t = parseGoalSpec(specWith(DESIGN, TASK("T1", "Bucket", body))).spec?.tasks[0];
    expect(t).toMatchObject({
      scope: ["src/rl/**"],
      on_dependency_failure: "block",
      retry: { max_attempts: 2, workspace: "reuse" },
      assumptions: ["redis is not needed"],
    });
  });
});

describe("goal-spec scenarios", () => {
  scenario("goal-spec", "Minimal design-only spec is accepted", () => {
    const r = check(specWith());
    expect(r.status).toBe(0);
  });

  scenario("goal-spec", "Missing Design section is rejected", () => {
    const r = check("# Rate limiting\n\nSome prose.\n");
    expect(r.status).toBe(1);
    expect(r.err).toContain("missing `## Design` section");
  });

  scenario("goal-spec", "Missing required subsection", () => {
    const r = check(
      specWith(DESIGN.replace("### Acceptance\n- 429 after 100 requests per minute\n", "")),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain("### Acceptance");
  });

  scenario("goal-spec", "Empty acceptance list", () => {
    const r = check(specWith(DESIGN.replace("- 429 after 100 requests per minute", "")));
    expect(r.status).toBe(1);
    expect(r.err).toContain("Acceptance` needs at least one list item");
  });

  scenario("goal-spec", "Free prose is ignored", () => {
    const design = `${DESIGN}\n### Approaches considered\nWe could use oracle: none here.\n`;
    const r = check(specWith(design));
    expect(r.status).toBe(0);
  });

  scenario("goal-spec", "Spec with open decisions", () => {
    const design = DESIGN.replace(
      "### Open decisions\n",
      "### Open decisions\n- which store backs rate counters\n",
    );
    const r = check(specWith(design));
    expect(r.status).toBe(0);
    expect(r.out).toContain("status draft");
    expect(r.out).toContain("which store backs rate counters");
  });

  scenario("goal-spec", "Spec without open decisions", () => {
    const r = check(specWith());
    expect(r.status).toBe(0);
    expect(r.out).toContain("status ready");
  });

  scenario("goal-spec", "Valid task entry", () => {
    const r = check(specWith(DESIGN, TASK("T1", "Token bucket")), "--output", "json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).data.tasks).toEqual([{ id: "T1", title: "Token bucket" }]);
  });

  scenario("goal-spec", "Duplicate task id", () => {
    const text = specWith(DESIGN, TASK("T1", "One") + TASK("T1", "Again"));
    const r = check(text);
    expect(r.status).toBe(1);
    const first = text.split("\n").indexOf("### T1 One") + 1;
    const second = text.split("\n").indexOf("### T1 Again") + 1;
    expect(r.err).toContain(`duplicate task id T1 (lines ${first} and ${second})`);
  });

  scenario("goal-spec", "Task heading without a block", () => {
    const r = check(specWith(DESIGN, "### T2 Headers\n\nprose only\n"));
    expect(r.status).toBe(1);
    expect(r.err).toContain("task T2 has no `sddx` block");
  });

  scenario("goal-spec", "Two blocks under one task", () => {
    const r = check(specWith(DESIGN, `${TASK("T2", "Headers")}${BLOCK(ORACLE)}\n`));
    expect(r.status).toBe(1);
    expect(r.err).toContain("task T2 has more than one `sddx` block");
  });

  scenario("goal-spec", "Missing oracle", () => {
    const r = check(specWith(DESIGN, TASK("T1", "Bucket", "scope: [src/rl/**]")));
    expect(r.status).toBe(1);
    expect(r.err).toContain("task T1: task has no oracle");
  });

  scenario("goal-spec", "Unsupported expect form", () => {
    const r = check(specWith(DESIGN, TASK("T1", "Bucket", ORACLE.replace("exit 0", '"passes"'))));
    expect(r.status).toBe(1);
    expect(r.err).toContain("oracle.expect: must be `exit <code>`");
  });

  scenario("goal-spec", "Oracle with setup and runs", () => {
    const body = `${ORACLE}\n  runs: 3\n  setup: bun install --frozen-lockfile`;
    const r = check(specWith(DESIGN, TASK("T1", "Bucket", body)));
    expect(r.status).toBe(0);
  });

  scenario("goal-spec", "Misspelled key", () => {
    const r = check(specWith(DESIGN, TASK("T1", "Bucket", `${ORACLE}\nscpoe: [src/rl/**]`)));
    expect(r.status).toBe(1);
    expect(r.err).toContain('unknown key "scpoe"');
  });

  scenario("goal-spec", "Several errors in one run", () => {
    const design = DESIGN.replace("### Goal\nLimit requests per client.\n", "");
    const r = check(specWith(design, TASK("T1", "Bucket", "scope: [src/**]")));
    expect(r.status).toBe(1);
    const lines = r.err.trim().split("\n");
    expect(lines.some((l) => /:\d+: ## Design is missing `### Goal`/.test(l))).toBe(true);
    expect(lines.some((l) => /:\d+: task T1: task has no oracle/.test(l))).toBe(true);
  });

  scenario("goal-spec", "JSON output", () => {
    const r = check(specWith(DESIGN, TASK("T1", "Bucket", "scope: [src/**]")), "--output", "json");
    expect(r.status).toBe(1);
    const env = JSON.parse(r.out);
    expect(env.schema_version).toBeDefined();
    expect(env.status).toBe("error");
    expect(env.data.errors[0]).toEqual({
      message: "task T1: task has no oracle; no oracle, no goal",
      path: ".sddx/specs/2026-10-26-rate-limit.md",
      line: expect.any(Number),
    });
    expect(env.errors[0]).toContain("task has no oracle");
  });
});
