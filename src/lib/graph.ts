// The decomposition graph: a cycle-free, single-parent forest of tasks plus the
// overlap ⟹ ordered invariant. `validateSchedule` is the plan-time gate — the
// deterministic refusal that replaces the orchestrator's prose "keep scopes
// disjoint". It works over abstract nodes (id + single parent + scope) so both
// `graph create` (alias nodes) and the standalone `goal create` (task-id nodes)
// share one checker.
import { parse } from "yaml";
import { scopesOverlap } from "./glob-overlap";

export interface GraphNode {
  alias: string;
  /** Path to the node's spec YAML (holds task/success_criteria/scope/oracle). */
  spec: string;
  /** Alias of the single predecessor, or null for a root. */
  depends_on: string | null;
}

export interface Graph {
  goal: string;
  tasks: GraphNode[];
}

const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  if (!Array.isArray(r.tasks) || r.tasks.length === 0) {
    errors.push("tasks: non-empty list of task nodes required");
    return { errors };
  }

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
    const dep =
      nr.depends_on === undefined || nr.depends_on === null ? null : String(nr.depends_on).trim();
    if (dep !== null && dep === alias) {
      errors.push(`tasks[${i}] (${alias}): a node cannot depend on itself`);
    }
    nodes.push({
      alias,
      spec: typeof nr.spec === "string" ? nr.spec.trim() : "",
      depends_on: dep === "" ? null : dep,
    });
  }

  // resolve depends_on aliases now that every node's alias is known
  for (const n of nodes) {
    if (n.depends_on !== null && !seen.has(n.depends_on)) {
      errors.push(`${n.alias}: depends_on names unknown alias "${n.depends_on}"`);
    }
  }

  if (errors.length > 0) return { errors };
  return { errors: [], graph: { goal: (r.goal as string).trim(), tasks: nodes } };
}

export interface ScheduleNode {
  /** Alias (graph create) or task id (goal create). */
  id: string;
  /** Single predecessor id, or null for a root. */
  dependsOn: string | null;
  scope: readonly string[];
}

/** Walk the parent chain from `id`; the ancestor set never includes `id` itself. */
function ancestors(id: string, parent: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  let cur = parent.get(id) ?? null;
  const guard = new Set<string>([id]);
  while (cur !== null && !guard.has(cur)) {
    out.add(cur);
    guard.add(cur);
    cur = parent.get(cur) ?? null;
  }
  return out;
}

/**
 * The gate. Returns a list of human-readable violations (empty = the schedule is
 * legal). Checks, in order: every dependency resolves, no cycles, and — the core
 * invariant — every pair of tasks the forest does not order has disjoint scope.
 */
export function validateSchedule(nodes: ScheduleNode[]): string[] {
  const errors: string[] = [];
  const parent = new Map<string, string | null>();
  for (const n of nodes) parent.set(n.id, n.dependsOn);

  // A `dependsOn` that isn't in this node set is an EXTERNAL, already-satisfied
  // dependency (e.g. `goal create` over a child whose parent shipped in another
  // goal) — not an error. Resolvability inside a graph is parseGraph's job.

  // cycle detection: follow each node's parent chain; revisiting a node = cycle
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    let cur = n.dependsOn;
    while (cur !== null && parent.has(cur)) {
      if (seen.has(cur)) {
        errors.push(`dependency cycle involving "${cur}"`);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur) ?? null;
    }
  }
  if (errors.length > 0) return dedupe(errors);

  // overlap ⟹ ordered: any unordered pair with overlapping scope is illegal
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as ScheduleNode;
      const b = nodes[j] as ScheduleNode;
      const ordered = ancestors(a.id, parent).has(b.id) || ancestors(b.id, parent).has(a.id);
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
