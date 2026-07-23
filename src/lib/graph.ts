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
  return { errors: [], graph: { goal: (r.goal as string).trim(), tasks: nodes } };
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
