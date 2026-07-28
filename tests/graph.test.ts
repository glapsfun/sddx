import { describe, expect, test } from "bun:test";
import {
  briefAssumptions,
  parseGraph,
  type ScheduleNode,
  truncateToHeader,
  validateSchedule,
} from "../src/lib/graph";
import { GRAPH_HEADER as HEADER } from "./helpers";

describe("parseGraph", () => {
  const GOOD = `${HEADER}goal: ship the thing
tasks:
  - alias: schema
    spec: specs/schema.yaml
  - alias: api
    spec: specs/api.yaml
    depends_on: schema
`;

  test("parses a well-formed graph with a root and a dependent", () => {
    const { graph, errors } = parseGraph(GOOD);
    expect(errors).toEqual([]);
    expect(graph!.goal).toBe("ship the thing");
    expect(graph!.tasks.map((t) => t.alias)).toEqual(["schema", "api"]);
    expect(graph!.tasks[1]!.depends_on).toEqual(["schema"]);
    expect(graph!.tasks[0]!.depends_on).toEqual([]);
  });

  test("parses a fan-in node with a depends_on list", () => {
    const y = `${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: b\n    spec: b.yaml\n  - alias: d\n    spec: d.yaml\n    depends_on: [a, b]\n`;
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    expect(graph!.tasks.find((t) => t.alias === "d")!.depends_on).toEqual(["a", "b"]);
  });

  test("rejects duplicate alias", () => {
    const y = `${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: a\n    spec: b.yaml\n`;
    expect(parseGraph(y).errors.join(" ")).toContain("duplicate alias");
  });

  test("rejects unknown depends_on alias", () => {
    const y = `${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n    depends_on: ghost\n`;
    expect(parseGraph(y).errors.join(" ")).toContain("unknown alias");
  });

  test("rejects self-dependency", () => {
    const y = `${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n    depends_on: a\n`;
    expect(parseGraph(y).errors.join(" ")).toContain("cannot depend on itself");
  });

  test("rejects missing goal or empty tasks", () => {
    expect(
      parseGraph(`${HEADER}tasks:\n  - alias: a\n    spec: a.yaml\n`).errors.join(" "),
    ).toContain("goal");
    expect(parseGraph(`${HEADER}goal: g\ntasks: []\n`).errors.join(" ")).toContain("tasks");
  });
});

// The Goal Brief lives in the graph draft's header rather than in a file of its
// own. Two writers share the file — intake writes only header keys, the
// orchestrator appends only `tasks:` — so the header rules are what keep a
// half-written draft out of the approval path.
describe("parseGraph: Goal Brief header", () => {
  test("a header-only draft is not a plan: parsing names the missing tasks list", () => {
    const y = `${HEADER}goal: ship the thing\n`;
    const { graph, errors } = parseGraph(y);
    expect(graph).toBeUndefined();
    expect(errors.join(" ")).toContain("tasks");
  });

  test("a tasks-bearing graph missing interaction_mode is rejected, naming the key", () => {
    const y = "schema_version: '1.0'\ngoal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n";
    expect(parseGraph(y).errors.join(" ")).toContain("interaction_mode");
  });

  test("a tasks-bearing graph missing schema_version is rejected, naming the key", () => {
    const y = "interaction_mode: human\ngoal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n";
    expect(parseGraph(y).errors.join(" ")).toContain("schema_version");
  });

  test("an interaction_mode outside human|auto is rejected", () => {
    const y =
      "schema_version: '1.0'\ninteraction_mode: yolo\ngoal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n";
    expect(parseGraph(y).errors.join(" ")).toContain("interaction_mode");
  });

  test("parses the full header", () => {
    const y = `${HEADER}goal: g
answers:
  - id: q1
    question: which database?
    answer: postgres
assumptions:
  - id: a1
    value: sessions are server-side
    rationale: no client storage in scope
constraints:
  - no new runtime dependencies
acceptance_criteria:
  - login returns a session cookie
out_of_scope:
  - password reset
unresolved:
  - whether to rotate secrets on deploy
tasks:
  - alias: a
    spec: a.yaml
`;
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    expect(graph!.schema_version).toBe("1.0");
    expect(graph!.interaction_mode).toBe("human");
    expect(graph!.answers).toEqual([{ id: "q1", question: "which database?", answer: "postgres" }]);
    expect(graph!.constraints).toEqual(["no new runtime dependencies"]);
    expect(graph!.acceptance_criteria).toEqual(["login returns a session cookie"]);
    expect(graph!.out_of_scope).toEqual(["password reset"]);
    expect(graph!.unresolved).toEqual(["whether to rotate secrets on deploy"]);
  });

  test("header list keys are optional", () => {
    const y = `${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    expect(graph!.answers).toEqual([]);
    expect(graph!.constraints).toEqual([]);
    expect(graph!.unresolved).toEqual([]);
  });

  test("an answers entry missing its answer is rejected, naming the entry", () => {
    const y = `${HEADER}goal: g\nanswers:\n  - id: q1\n    question: which database?\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    const errs = parseGraph(y).errors.join(" ");
    expect(errs).toContain("answers[0]");
    expect(errs).toContain("answer");
  });

  test("an answers entry that is not a mapping is rejected", () => {
    const y = `${HEADER}goal: g\nanswers:\n  - just a string\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    expect(parseGraph(y).errors.join(" ")).toContain("answers[0]");
  });

  test("an empty answers list is rejected, as an empty assumptions list already is", () => {
    const y = `${HEADER}goal: g\nanswers: []\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    expect(parseGraph(y).errors.join(" ")).toContain("answers");
  });

  test("a structured assumption is accepted alongside the legacy string form", () => {
    const y = `${HEADER}goal: g
assumptions:
  - id: a1
    value: sessions are server-side
    rationale: no client storage in scope
tasks:
  - alias: a
    spec: a.yaml
`;
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    // flattened onto the existing string path so `mergeAssumptions` and every
    // receipt downstream of it stay unchanged
    expect(graph!.assumptions).toEqual(["sessions are server-side — no client storage in scope"]);
  });

  test("a structured assumption missing its rationale is rejected", () => {
    const y = `${HEADER}goal: g\nassumptions:\n  - id: a1\n    value: v\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    const errs = parseGraph(y).errors.join(" ");
    expect(errs).toContain("assumptions[0]");
    expect(errs).toContain("rationale");
  });

  test("briefAssumptions renders answers alongside assumptions for denormalization", () => {
    const y = `${HEADER}goal: g
answers:
  - id: q1
    question: which store?
    answer: postgres
assumptions:
  - sessions are server-side
tasks:
  - alias: a
    spec: a.yaml
`;
    const { graph } = parseGraph(y);
    // assumptions first, then answers — an answer is labelled so a receipt
    // reader can tell a decision the user made from one sddx guessed
    expect(briefAssumptions(graph!)).toEqual([
      "sessions are server-side",
      "answered: which store? → postgres",
    ]);
  });

  test("briefAssumptions is empty for a header carrying neither", () => {
    const { graph } = parseGraph(`${HEADER}goal: g\ntasks:\n  - alias: a\n    spec: a.yaml\n`);
    expect(briefAssumptions(graph!)).toEqual([]);
  });

  test("legacy string assumptions still parse", () => {
    const y = `${HEADER}goal: g\nassumptions:\n  - sessions are server-side\ntasks:\n  - alias: a\n    spec: a.yaml\n`;
    const { graph, errors } = parseGraph(y);
    expect(errors).toEqual([]);
    expect(graph!.assumptions).toEqual(["sessions are server-side"]);
  });
});

describe("validateSchedule (overlap ⟹ ordered)", () => {
  const n = (id: string, dependsOn: string | string[] | null, scope: string[]): ScheduleNode => ({
    id,
    dependsOn: dependsOn === null ? [] : Array.isArray(dependsOn) ? dependsOn : [dependsOn],
    scope,
  });

  test("concurrent overlapping tasks rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/db/**"]),
      n("b", null, ["src/db/schema.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"a"');
    expect(errs.join(" ")).toContain('"b"');
  });

  test("ancestor-ordered overlapping tasks accepted", () => {
    expect(
      validateSchedule([n("a", null, ["src/db/**"]), n("b", "a", ["src/db/schema.ts"])]),
    ).toEqual([]);
  });

  test("disjoint concurrent tasks accepted", () => {
    expect(validateSchedule([n("a", null, ["src/api/**"]), n("b", null, ["src/db/**"])])).toEqual(
      [],
    );
  });

  test("sibling overlap under a shared parent rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/root.ts"]),
      n("b", "a", ["src/shared/**"]),
      n("c", "a", ["src/shared/x.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"b"');
    expect(errs.join(" ")).toContain('"c"');
  });

  test("transitive ancestor ordering allows overlap down a chain", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/x.ts"]),
        n("b", "a", ["src/y.ts"]),
        n("c", "b", ["src/x.ts"]),
      ]),
    ).toEqual([]);
  });

  test("cycle rejected", () => {
    const errs = validateSchedule([n("a", "b", []), n("b", "a", [])]);
    expect(errs.join(" ")).toContain("cycle");
  });

  test("an external (unlisted) parent is tolerated, not an error", () => {
    // `goal create` may list a child whose parent shipped in another goal — the
    // external edge is treated as already-satisfied, not "unknown". Resolvability
    // within a graph is parseGraph's job (tested above).
    expect(validateSchedule([n("a", "external-parent", ["src/a.ts"])])).toEqual([]);
  });

  test("legacy all-root, no-scope goal passes unchanged", () => {
    expect(validateSchedule([n("a", null, []), n("b", null, []), n("c", null, [])])).toEqual([]);
  });

  test("fan-in (two parents, no cycle) is accepted when scopes are disjoint", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/a.ts"]),
        n("b", null, ["src/b.ts"]),
        n("d", ["a", "b"], ["src/d.ts"]),
      ]),
    ).toEqual([]);
  });

  test("co-parents of a shared fan-in child with overlapping scope are rejected", () => {
    const errs = validateSchedule([
      n("a", null, ["src/shared/**"]),
      n("b", null, ["src/shared/x.ts"]),
      n("d", ["a", "b"], ["src/d.ts"]),
    ]);
    expect(errs.join(" ")).toContain("scope overlap");
    expect(errs.join(" ")).toContain('"a"');
    expect(errs.join(" ")).toContain('"b"');
  });

  test("cycle through a multi-parent edge is rejected", () => {
    const errs = validateSchedule([n("a", ["c"], []), n("b", ["a"], []), n("c", ["b"], [])]);
    expect(errs.join(" ")).toContain("cycle");
  });

  test("a fan-in child may overlap either of its (disjoint) parents' scope", () => {
    expect(
      validateSchedule([
        n("a", null, ["src/a.ts"]),
        n("b", null, ["src/b.ts"]),
        n("d", ["a", "b"], ["src/a.ts"]),
      ]),
    ).toEqual([]);
  });
});

// Regenerate discards a decomposition and re-plans from the unchanged brief.
// Because the brief IS this file's header, that is a truncation at a known
// boundary — and it must be a TEXTUAL one: re-serializing the YAML would
// reformat the header, change the graph bytes, and so invalidate an approval
// over a brief nobody edited.
describe("truncateToHeader", () => {
  const HEADERED = `${HEADER}goal: ship the thing
answers:
  - id: q1
    question: which store?
    answer: postgres
tasks:
  - alias: a
    spec: a.yaml
  - alias: b
    spec: b.yaml
    depends_on: a
`;

  test("drops the tasks block and leaves the header byte-identical", () => {
    const out = truncateToHeader(HEADERED);
    expect(out).toBe(`${HEADER}goal: ship the thing
answers:
  - id: q1
    question: which store?
    answer: postgres
`);
    // what survives is exactly the prefix that was there before
    expect(HEADERED.startsWith(out)).toBe(true);
  });

  test("the result is a valid intake output and an invalid plan", () => {
    const { graph, errors } = parseGraph(truncateToHeader(HEADERED));
    expect(graph).toBeUndefined();
    expect(errors.join(" ")).toContain("tasks");
  });

  test("a comment inside the tasks block does not end the block", () => {
    // The defect this guards: "column 0 and not a list item" treated a comment
    // between two task entries as the next top-level key, so the rest of the
    // list was copied into the "header" and regenerate wrote back a mapping
    // followed by a bare sequence item — unparseable YAML, reported as success.
    const y = `${HEADER}goal: ship the thing
tasks:
  - alias: a
    spec: a.yaml
# b comes after a
  - alias: b
    spec: b.yaml
`;
    const out = truncateToHeader(y);
    expect(out).not.toContain("alias: b");
    // and what is written back still parses — as a header-only draft
    expect(parseGraph(out).errors.join(" ")).toContain("tasks");
  });

  test("keeps header keys that follow the tasks block", () => {
    // the orchestrator is told to append, but a hand-edited draft need not obey
    const y = `${HEADERED}unresolved:\n  - "whether to rotate secrets"\n`;
    const out = truncateToHeader(y);
    expect(out).toContain("unresolved:");
    expect(out).toContain("whether to rotate secrets");
    expect(out).not.toContain("alias: a");
  });

  test("a header-only draft is unchanged — regenerating twice is safe", () => {
    const headerOnly = `${HEADER}goal: ship the thing\n`;
    expect(truncateToHeader(headerOnly)).toBe(headerOnly);
  });

  test("an inline tasks list is dropped too", () => {
    const y = `${HEADER}goal: g\ntasks: []\n`;
    expect(truncateToHeader(y)).toBe(`${HEADER}goal: g\n`);
  });
});
