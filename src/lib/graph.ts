// The decomposition graph: a cycle-free DAG of tasks (fan-out AND fan-in) plus
// the overlap ⟹ ordered invariant. `validateSchedule` is the plan-time gate —
// the deterministic refusal that replaces the orchestrator's prose "keep
// scopes disjoint". It works over abstract nodes (id + parents + scope) so both
// `graph create` (alias nodes) and the standalone `goal create` (task-id nodes)
// share one checker.
import { parse } from "yaml";
import { scopesOverlap } from "./glob-overlap";

export interface GraphNode {
  alias: string;
  /** Path to the node's spec YAML (holds task/success_criteria/scope/oracle). */
  spec: string;
  /** Aliases of every predecessor (a scalar `depends_on: a` normalizes to one
   * entry); empty for a root. */
  depends_on: string[];
}

/** One question the intake role asked and the human answered. */
export interface GraphAnswer {
  id: string;
  question: string;
  answer: string;
}

export type InteractionMode = "human" | "auto";

export interface Graph {
  goal: string;
  tasks: GraphNode[];
  /** Cross-cutting decisions resolved without asking, denormalized into every
   * node's spec at create time so each receipt stays self-contained. */
  assumptions: string[];
  // ── Goal Brief header ──────────────────────────────────────────────────────
  // The brief is this file's header rather than a document of its own, so the
  // byte-level `planHash` over the graph covers it for free and a draft that
  // has a header but no `tasks:` is unapprovable by the parser that already
  // exists. Intake writes these keys; the orchestrator appends `tasks:`.
  schema_version: string;
  interaction_mode: InteractionMode;
  /** What the human was asked and decided. Denormalized alongside
   * `assumptions` so a receipt records the decisions, not just the guesses. */
  answers: GraphAnswer[];
  constraints: string[];
  acceptance_criteria: string[];
  /** Decisions intake could not settle. Non-empty refuses an autonomous run —
   * an additional trigger layered on the deterministic path bounds, never the
   * only one. */
  unresolved: string[];
  out_of_scope: string[];
}

const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTERACTION_MODES: readonly InteractionMode[] = ["human", "auto"];

/** The shape rule shared by every free-text header list and by a spec's
 * `assumptions`: optional, but present means a non-empty list of non-empty
 * strings — an empty list is a malformed value, not "none" (omit the key). */
function stringList(key: string, value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((s) => typeof s === "string" && s.trim() !== "")
  ) {
    errors.push(`${key}: when present, must be a non-empty list of non-empty strings`);
    return [];
  }
  return value.map((s) => (s as string).trim());
}

/** Reads `field` off a header entry, recording a message that names both the
 * entry and the field when it is missing or blank. */
function entryField(
  key: string,
  i: number,
  entry: Record<string, unknown>,
  field: string,
  errors: string[],
): string {
  const v = entry[field];
  if (typeof v !== "string" || v.trim() === "") {
    errors.push(`${key}[${i}]: missing "${field}"`);
    return "";
  }
  return v.trim();
}

function parseAnswers(value: unknown, errors: string[]): GraphAnswer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("answers: when present, must be a non-empty list of {id, question, answer}");
    return [];
  }
  const out: GraphAnswer[] = [];
  for (let i = 0; i < value.length; i++) {
    const e = value[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      errors.push(`answers[${i}]: must be a mapping with id, question and answer`);
      continue;
    }
    const r = e as Record<string, unknown>;
    out.push({
      id: entryField("answers", i, r, "id", errors),
      question: entryField("answers", i, r, "question", errors),
      answer: entryField("answers", i, r, "answer", errors),
    });
  }
  return out;
}

/**
 * Assumptions accept two forms so the header can be structured without
 * disturbing anything downstream: a bare string (the original form) or a
 * `{id, value, rationale}` mapping, which flattens to one string here. Every
 * consumer — `mergeAssumptions`, specs, receipts — keeps seeing `string[]`.
 */
function parseAssumptions(value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("assumptions: when present, must be a non-empty list of non-empty values");
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const e = value[i];
    if (typeof e === "string") {
      if (e.trim() === "") errors.push(`assumptions[${i}]: must not be empty`);
      else out.push(e.trim());
      continue;
    }
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      errors.push(`assumptions[${i}]: must be a string or a mapping with id, value and rationale`);
      continue;
    }
    const r = e as Record<string, unknown>;
    entryField("assumptions", i, r, "id", errors);
    const v = entryField("assumptions", i, r, "value", errors);
    const rationale = entryField("assumptions", i, r, "rationale", errors);
    if (v !== "" && rationale !== "") out.push(`${v} — ${rationale}`);
  }
  return out;
}

export function parseGraph(yamlText: string): { graph?: Graph; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { errors: [`invalid YAML: ${(e as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { errors: ["graph must be a YAML mapping"] };
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.goal !== "string" || r.goal.trim() === "") {
    errors.push("goal: one-sentence description required");
  }
  // A header-only draft stops here. That is the whole reason the brief lives in
  // this file: intake's output fails the parser that already exists, so it can
  // never be fingerprinted, approved or materialized — no new gate required.
  if (!Array.isArray(r.tasks) || r.tasks.length === 0) {
    errors.push("tasks: non-empty list of task nodes required");
    return { errors };
  }

  // Past this point the draft claims to be a plan, so it must carry a complete
  // Goal Brief header.
  const schemaVersion =
    typeof r.schema_version === "string" || typeof r.schema_version === "number"
      ? String(r.schema_version).trim()
      : "";
  if (schemaVersion === "") {
    errors.push("schema_version: required in the Goal Brief header of a planned graph");
  }
  const mode = typeof r.interaction_mode === "string" ? r.interaction_mode.trim() : "";
  if (!INTERACTION_MODES.includes(mode as InteractionMode)) {
    errors.push(
      `interaction_mode: required in the Goal Brief header, one of ${INTERACTION_MODES.join("|")}`,
    );
  }
  const answers = parseAnswers(r.answers, errors);
  const assumptions = parseAssumptions(r.assumptions, errors);
  const constraints = stringList("constraints", r.constraints, errors);
  const acceptanceCriteria = stringList("acceptance_criteria", r.acceptance_criteria, errors);
  const outOfScope = stringList("out_of_scope", r.out_of_scope, errors);
  const unresolved = stringList("unresolved", r.unresolved, errors);

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < r.tasks.length; i++) {
    const n = r.tasks[i];
    if (typeof n !== "object" || n === null || Array.isArray(n)) {
      errors.push(`tasks[${i}]: must be a mapping`);
      continue;
    }
    const nr = n as Record<string, unknown>;
    const alias = typeof nr.alias === "string" ? nr.alias.trim() : "";
    if (!ALIAS_RE.test(alias)) {
      errors.push(`tasks[${i}].alias: lowercase-hyphen identifier required`);
    } else if (seen.has(alias)) {
      errors.push(`tasks[${i}].alias: duplicate alias "${alias}"`);
    } else {
      seen.add(alias);
    }
    if (typeof nr.spec !== "string" || nr.spec.trim() === "") {
      errors.push(`tasks[${i}] (${alias || i}).spec: path to the node's spec YAML required`);
    }
    // depends_on may be a bare scalar (one parent) or a list (fan-in); absent/
    // null/empty means root.
    const rawDeps: unknown[] =
      nr.depends_on === undefined || nr.depends_on === null
        ? []
        : Array.isArray(nr.depends_on)
          ? nr.depends_on
          : [nr.depends_on];
    const deps = rawDeps.map((d) => String(d).trim()).filter((d) => d !== "");
    if (deps.includes(alias)) {
      errors.push(`tasks[${i}] (${alias}): a node cannot depend on itself`);
    }
    nodes.push({
      alias,
      spec: typeof nr.spec === "string" ? nr.spec.trim() : "",
      depends_on: deps.filter((d) => d !== alias),
    });
  }

  // resolve depends_on aliases now that every node's alias is known
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!seen.has(dep)) {
        errors.push(`${n.alias}: depends_on names unknown alias "${dep}"`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return {
    errors: [],
    graph: {
      goal: (r.goal as string).trim(),
      tasks: nodes,
      assumptions,
      schema_version: schemaVersion,
      interaction_mode: mode as InteractionMode,
      answers,
      constraints,
      acceptance_criteria: acceptanceCriteria,
      unresolved,
      out_of_scope: outOfScope,
    },
  };
}

/**
 * The draft with its `tasks:` block removed — a plan reduced back to the Goal
 * Brief it was planned from. This is what Regenerate does: discard the
 * decomposition, keep everything the user decided.
 *
 * It is deliberately TEXTUAL, not a parse-and-re-serialize. Re-emitting the
 * YAML would reformat the header, move the graph bytes, and so invalidate an
 * approval over a brief nobody edited — the exact false invalidation the
 * byte-level plan hash exists to make meaningful. Every surviving line is the
 * line that was there before.
 *
 * Only the `tasks:` block goes: its key line plus the indented/list lines under
 * it, stopping at the next top-level key. A header key written *after* `tasks:`
 * survives, since the orchestrator appending last is a convention, not a rule.
 */
/** A mapping key at column 0: not indented, not a list item, not a comment. */
const TOP_LEVEL_KEY = /^[^\s#-][^:]*:/;

export function truncateToHeader(yamlText: string): string {
  const lines = yamlText.split("\n");
  const out: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (dropping) {
      // Only a top-level KEY line ends the block. Testing "column 0 and not a
      // list item" instead treated a comment sitting between two task entries
      // as the next key, so the rest of the list was copied into the header and
      // the file written back was unparseable YAML — a mapping followed by a
      // bare sequence item — while the command reported success.
      if (TOP_LEVEL_KEY.test(line)) dropping = false;
      else continue;
    }
    if (/^tasks:/.test(line)) {
      dropping = true;
      continue;
    }
    out.push(line);
  }
  const text = out.join("\n");
  // The file's final newline lives in a trailing empty element, which the
  // dropped block swallows when `tasks:` is last — which it usually is.
  return yamlText.endsWith("\n") && text !== "" && !text.endsWith("\n") ? `${text}\n` : text;
}

/**
 * The goal-level conditions denormalized into every node's spec at create time:
 * what sddx assumed, then what the user actually decided. Answers ride the
 * existing `assumptions` path rather than a parallel field, because the point
 * of denormalizing at all is that a receipt needing a second file to be
 * interpreted stops being a receipt — and graph drafts get swept.
 *
 * Answers are labelled so a receipt reader can still tell a decision the user
 * made from one sddx guessed on their behalf.
 */
export function briefAssumptions(graph: Graph): string[] {
  return [
    ...graph.assumptions,
    ...graph.answers.map((a) => `answered: ${a.question} → ${a.answer}`),
  ];
}

export interface ScheduleNode {
  /** Alias (graph create) or task id (goal create). */
  id: string;
  /** Predecessor ids — zero or more (fan-in allowed); empty for a root. */
  dependsOn: readonly string[];
  scope: readonly string[];
}

/** Reachability walk over every incoming edge (a node may have several
 * parents); the ancestor set never includes `id` itself. `guard` prevents
 * infinite recursion through a cycle (cycle detection itself runs separately
 * and rejects the graph before this is ever relied on for correctness). */
function ancestors(
  id: string,
  parents: Map<string, readonly string[]>,
  guard: Set<string> = new Set([id]),
): Set<string> {
  const out = new Set<string>();
  for (const p of parents.get(id) ?? []) {
    if (guard.has(p)) continue;
    guard.add(p);
    out.add(p);
    for (const a of ancestors(p, parents, guard)) out.add(a);
  }
  return out;
}

/**
 * The gate. Returns a list of human-readable violations (empty = the schedule is
 * legal). Checks, in order: no cycles, and — the core invariant — every pair of
 * tasks the DAG does not order (including two parents that both feed the same
 * fan-in child) has disjoint scope.
 */
export function validateSchedule(nodes: ScheduleNode[]): string[] {
  const errors: string[] = [];
  const parents = new Map<string, readonly string[]>();
  for (const n of nodes) parents.set(n.id, n.dependsOn);

  // A dependency that isn't in this node set is an EXTERNAL, already-satisfied
  // dependency (e.g. `goal create` over a child whose parent shipped in another
  // goal) — not an error. Resolvability inside a graph is parseGraph's job.

  // cycle detection: DFS with a recursion-stack guard over all parent edges
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) color.set(n.id, WHITE);
  const visit = (id: string): string | null => {
    color.set(id, GRAY);
    for (const p of parents.get(id) ?? []) {
      const c = color.get(p);
      if (c === GRAY) return p;
      if (c === WHITE) {
        const found = visit(p);
        if (found) return found;
      }
    }
    color.set(id, BLACK);
    return null;
  };
  for (const n of nodes) {
    if (color.get(n.id) !== WHITE) continue;
    const cyclic = visit(n.id);
    if (cyclic) errors.push(`dependency cycle involving "${cyclic}"`);
  }
  if (errors.length > 0) return dedupe(errors);

  // overlap ⟹ ordered: any unordered pair with overlapping scope is illegal —
  // this already covers two parents of a shared fan-in child, since neither is
  // the other's ancestor/descendant.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as ScheduleNode;
      const b = nodes[j] as ScheduleNode;
      const ordered = ancestors(a.id, parents).has(b.id) || ancestors(b.id, parents).has(a.id);
      if (!ordered && scopesOverlap(a.scope, b.scope)) {
        errors.push(
          `scope overlap between concurrent tasks "${a.id}" and "${b.id}" — order one after the other or make their scopes disjoint`,
        );
      }
    }
  }
  return dedupe(errors);
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
