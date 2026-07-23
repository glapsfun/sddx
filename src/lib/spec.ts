import { parse } from "yaml";

export type OracleType = "command" | "test-suite" | "browser" | "manual";

export interface Oracle {
  type: OracleType;
  run: string;
  expect: string;
  /** Verify executes the oracle this many times; every run must pass. Default 1. */
  runs?: number;
}

export type DependencyFailurePolicy = "skip" | "block";

export interface RetryPolicy {
  max_attempts: number;
  workspace: "fresh" | "reuse";
}

export interface Spec {
  task: string;
  context: string[];
  success_criteria: string[];
  oracle: Oracle;
  stop_rules: Array<string | Record<string, unknown>>;
  out_of_scope: string[];
  /** Write globs the task is permitted to touch. Empty when the spec omits `scope`. */
  scope: string[];
  /** What a dependent of this task does if this task never reaches DONE. Absent
   * when the spec omits it — defaults to `skip` once the task is created. Not
   * relational (no sibling id), unlike `depends_on`, which stays out of the spec
   * (see `graph.yaml`) — authored directly here like `scope`. */
  on_dependency_failure?: DependencyFailurePolicy;
  /** Bounded automatic retry before this task is truly ABANDONED. Absent fields
   * default to `max_attempts: 1, workspace: 'fresh'` (today's single-attempt
   * behavior) once the task is created. */
  retry?: Partial<RetryPolicy>;
}

const ORACLE_TYPES: ReadonlySet<string> = new Set(["command", "test-suite", "browser", "manual"]);

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}

export function parseSpec(yamlText: string): { spec?: Spec; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { errors: [`invalid YAML: ${(e as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { errors: ["spec must be a YAML mapping"] };
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.task !== "string" || r.task.trim() === "") {
    errors.push("task: one-sentence description required");
  }
  const sc = r.success_criteria;
  if (
    !Array.isArray(sc) ||
    sc.length === 0 ||
    !sc.every((s) => typeof s === "string" && s.trim() !== "")
  ) {
    errors.push("success_criteria: non-empty list of binary criteria required");
  }
  const o = r.oracle;
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    errors.push("oracle: required — no oracle, no goal");
  } else {
    const or = o as Record<string, unknown>;
    if (typeof or.type !== "string" || !ORACLE_TYPES.has(or.type)) {
      errors.push("oracle.type: must be one of command | test-suite | browser | manual");
    }
    if (or.type !== "manual" && (typeof or.run !== "string" || or.run.trim() === "")) {
      errors.push("oracle.run: command required for non-manual oracles");
    }
    if (
      or.runs !== undefined &&
      (typeof or.runs !== "number" || !Number.isInteger(or.runs) || or.runs < 1)
    ) {
      errors.push("oracle.runs: must be an integer >= 1");
    }
  }
  // `scope` is optional; only validated when present. A present scope must be a
  // non-empty list of non-empty globs (a bare string or empty list is a mistake,
  // not a lane declaration) — reject rather than silently coerce.
  if (r.scope !== undefined) {
    if (
      !Array.isArray(r.scope) ||
      r.scope.length === 0 ||
      !r.scope.every((s) => typeof s === "string" && s.trim() !== "")
    ) {
      errors.push("scope: when present, must be a non-empty list of non-empty globs");
    }
  }
  // `on_dependency_failure` and `retry` carry no cross-task reference (unlike
  // `depends_on`, which stays out of the spec) — shape-validated here exactly
  // like `scope`, itemized in the same multi-error pass.
  if (
    r.on_dependency_failure !== undefined &&
    r.on_dependency_failure !== "skip" &&
    r.on_dependency_failure !== "block"
  ) {
    errors.push("on_dependency_failure: must be one of skip | block");
  }
  const retryRaw = r.retry;
  if (retryRaw !== undefined) {
    if (typeof retryRaw !== "object" || retryRaw === null || Array.isArray(retryRaw)) {
      errors.push("retry: must be a mapping with optional max_attempts/workspace");
    } else {
      const rr = retryRaw as Record<string, unknown>;
      if (
        rr.max_attempts !== undefined &&
        (typeof rr.max_attempts !== "number" ||
          !Number.isInteger(rr.max_attempts) ||
          rr.max_attempts < 1)
      ) {
        errors.push("retry.max_attempts: must be an integer >= 1");
      }
      if (rr.workspace !== undefined && rr.workspace !== "fresh" && rr.workspace !== "reuse") {
        errors.push("retry.workspace: must be one of fresh | reuse");
      }
    }
  }
  if (errors.length > 0) return { errors };

  const or = o as Record<string, unknown>;
  return {
    errors: [],
    spec: {
      task: (r.task as string).trim(),
      context: toList(r.context),
      success_criteria: (sc as string[]).map((s) => s.trim()),
      scope: Array.isArray(r.scope) ? (r.scope as string[]).map((s) => s.trim()) : [],
      oracle: {
        type: or.type as OracleType,
        run: typeof or.run === "string" ? or.run.trim() : "",
        expect: typeof or.expect === "string" ? or.expect.trim() : "exit 0",
        ...(typeof or.runs === "number" ? { runs: or.runs } : {}),
      },
      stop_rules: Array.isArray(r.stop_rules)
        ? (r.stop_rules as Array<string | Record<string, unknown>>)
        : [],
      out_of_scope: toList(r.out_of_scope),
      ...(r.on_dependency_failure !== undefined
        ? { on_dependency_failure: r.on_dependency_failure as DependencyFailurePolicy }
        : {}),
      ...(retryRaw !== undefined && typeof retryRaw === "object" && retryRaw !== null
        ? {
            retry: {
              ...(typeof (retryRaw as Record<string, unknown>).max_attempts === "number"
                ? { max_attempts: (retryRaw as Record<string, unknown>).max_attempts as number }
                : {}),
              ...(typeof (retryRaw as Record<string, unknown>).workspace === "string"
                ? {
                    workspace: (retryRaw as Record<string, unknown>).workspace as "fresh" | "reuse",
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}
