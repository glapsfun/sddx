import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuestionBatch, QUESTION_CAP } from "../src/lib/intake";
import { repoRoot } from "./helpers";

const q = (id: string) =>
  `  - id: ${id}\n    question: which store?\n    why: it changes the oracle\n`;
const batch = (n: number) =>
  `questions:\n${Array.from({ length: n }, (_, i) => q(`q${i + 1}`)).join("")}`;

describe("parseQuestionBatch", () => {
  test("accepts a batch at the cap", () => {
    const { questions, errors } = parseQuestionBatch(batch(QUESTION_CAP));
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(QUESTION_CAP);
  });

  test("rejects a batch over the cap, naming it rather than truncating", () => {
    // In a project whose thesis is that prompt instructions do not hold, a cap
    // enforced only by prompt is not a cap. Truncating would be worse still:
    // it silently discards the question intake thought mattered most.
    const { questions, errors } = parseQuestionBatch(batch(QUESTION_CAP + 1));
    expect(questions).toBeUndefined();
    expect(errors.join(" ")).toContain(String(QUESTION_CAP));
    expect(errors.join(" ")).toContain("4");
  });

  test("a well-specified goal returns an empty batch, which is valid", () => {
    // asking nothing is a success, not a shortfall
    for (const empty of ["questions: []\n", "{}\n", ""]) {
      const { questions, errors } = parseQuestionBatch(empty);
      expect(errors).toEqual([]);
      expect(questions).toEqual([]);
    }
  });

  test("parses id, question, why and an optional default", () => {
    const { questions, errors } = parseQuestionBatch(
      "questions:\n  - id: q1\n    question: which store?\n    why: it changes the oracle\n    default: postgres\n",
    );
    expect(errors).toEqual([]);
    expect(questions?.[0]).toEqual({
      id: "q1",
      question: "which store?",
      why: "it changes the oracle",
      default: "postgres",
    });
  });

  test("a question without a why is rejected — an unjustified question is not material", () => {
    const errs = parseQuestionBatch("questions:\n  - id: q1\n    question: which store?\n").errors;
    expect(errs.join(" ")).toContain("questions[0]");
    expect(errs.join(" ")).toContain("why");
  });

  test("a duplicate question id is rejected, since answers are recorded by id", () => {
    const errs = parseQuestionBatch(batch(2).replace("id: q2", "id: q1")).errors;
    expect(errs.join(" ")).toContain("q1");
  });

  test("a non-mapping entry is rejected", () => {
    const errs = parseQuestionBatch("questions:\n  - just a string\n").errors;
    expect(errs.join(" ")).toContain("questions[0]");
  });

  test("a mapping that is not a batch is rejected, not read as zero questions", () => {
    // The graph header is the file that gets written here by mistake. Passing
    // it as "0 questions" sends an unreviewed plan past the one round of
    // questions — the same vacuous pass the caller refuses for an unreadable
    // file, arrived at from a readable one.
    const { questions, errors } = parseQuestionBatch(
      'schema_version: "1.0"\ninteraction_mode: human\ngoal: ship it\n',
    );
    expect(questions).toBeUndefined();
    expect(errors.join(" ")).toContain("questions");
  });

  test("malformed YAML reports an error instead of an empty batch", () => {
    const { questions, errors } = parseQuestionBatch("questions:\n  - id: [unclosed\n");
    expect(questions).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("sddx intake check", () => {
  const CLI_SRC = join(repoRoot, "src/cli.ts");
  function check(text: string) {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-intake-"));
    const path = join(cwd, "questions.yaml");
    writeFileSync(path, text);
    return spawnSync("bun", [CLI_SRC, "intake", "check", "--batch", path], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
  }

  test("accepts a batch at the cap", () => {
    const r = check(batch(QUESTION_CAP));
    expect(r.status).toBe(0);
  });

  test("refuses a batch over the cap, naming it", () => {
    const r = check(batch(QUESTION_CAP + 1));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(String(QUESTION_CAP));
  });

  test("accepts an empty batch — a well-specified goal asks nothing", () => {
    const r = check("questions: []\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0");
  });

  test("reports the parsed batch as structured data", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-intake-"));
    const path = join(cwd, "questions.yaml");
    writeFileSync(path, batch(2));
    const r = spawnSync("bun", [CLI_SRC, "intake", "check", "--batch", path, "--output", "json"], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout).data;
    expect(data.count).toBe(2);
    expect(data.cap).toBe(QUESTION_CAP);
    expect(data.questions[0].id).toBe("q1");
  });

  test("a readable file that is not a batch fails rather than passing vacuously", () => {
    const r = check('schema_version: "1.0"\ninteraction_mode: human\ngoal: ship it\n');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("questions");
  });

  test("a missing batch file fails rather than passing vacuously", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-intake-"));
    const r = spawnSync("bun", [CLI_SRC, "intake", "check", "--batch", join(cwd, "nope.yaml")], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).not.toBe(0);
  });
});
