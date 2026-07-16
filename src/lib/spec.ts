import { parse } from "yaml";

export type OracleType = "command" | "test-suite" | "browser" | "manual";

export interface Oracle {
  type: OracleType;
  run: string;
  expect: string;
}

export interface Spec {
  task: string;
  context: string[];
  success_criteria: string[];
  oracle: Oracle;
  stop_rules: Array<string | Record<string, unknown>>;
  out_of_scope: string[];
}

const ORACLE_TYPES: ReadonlySet<string> = new Set([
  "command",
  "test-suite",
  "browser",
  "manual",
]);

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
  }
  if (errors.length > 0) return { errors };

  const or = o as Record<string, unknown>;
  return {
    errors: [],
    spec: {
      task: (r.task as string).trim(),
      context: toList(r.context),
      success_criteria: (sc as string[]).map((s) => s.trim()),
      oracle: {
        type: or.type as OracleType,
        run: typeof or.run === "string" ? or.run.trim() : "",
        expect: typeof or.expect === "string" ? or.expect.trim() : "exit 0",
      },
      stop_rules: Array.isArray(r.stop_rules)
        ? (r.stop_rules as Array<string | Record<string, unknown>>)
        : [],
      out_of_scope: toList(r.out_of_scope),
    },
  };
}
