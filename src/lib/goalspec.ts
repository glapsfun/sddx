// The goal spec: one markdown file per goal. Humans read all of it; sddx
// interprets only its skeleton (headings, list items under the required Design
// subsections) and the fenced `sddx` blocks under `## Tasks`. Everything else is
// prose, never parsed, so wording can change without changing what is checked.
//
// The scanner is line-based on purpose: sddx needs headings, fences and list
// items, and a full CommonMark parser would add weight and dialect questions
// (setext headings, nested containers) that cannot change any of those.
import { parse } from "yaml";
import {
  type DependencyFailurePolicy,
  ORACLE_TYPES,
  type Oracle,
  type OracleType,
  type RetryPolicy,
} from "./spec";

export const SPEC_DIR = ".sddx/specs";
export const TASK_ID_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
export const TASK_BLOCK_KEYS = [
  "oracle",
  "scope",
  "depends_on",
  "on_dependency_failure",
  "retry",
  "assumptions",
] as const;
const ORACLE_KEYS = new Set(["type", "run", "expect", "runs", "setup"]);

export const DESIGN_SECTIONS = [
  "Goal",
  "Acceptance",
  "Non-goals",
  "Assumptions",
  "Open decisions",
] as const;
export type DesignSection = (typeof DESIGN_SECTIONS)[number];

export interface SpecError {
  message: string;
  line: number | null;
}

export interface SpecTask {
  id: string;
  title: string;
  line: number;
  oracle: Oracle;
  scope: string[];
  depends_on: string[];
  on_dependency_failure?: DependencyFailurePolicy;
  retry?: Partial<RetryPolicy>;
  assumptions: string[];
}

export interface GoalSpec {
  title: string;
  design: {
    goal: string;
    acceptance: string[];
    nonGoals: string[];
    assumptions: string[];
    openDecisions: string[];
  };
  status: "draft" | "ready";
  tasks: SpecTask[];
}

export interface ParseResult {
  spec?: GoalSpec;
  errors: SpecError[];
}

interface Line {
  n: number;
  text: string;
  inFence: boolean;
}

interface Heading {
  level: number;
  text: string;
  line: number;
  index: number;
}

interface Fence {
  info: string;
  openLine: number;
  body: string;
  index: number;
}

interface Scan {
  lines: Line[];
  headings: Heading[];
  fences: Fence[];
  unclosedFence: number | null;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

function scan(text: string): Scan {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  const headings: Heading[] = [];
  const fences: Fence[] = [];
  let open: {
    marker: string;
    info: string;
    openLine: number;
    index: number;
    body: string[];
  } | null = null;
  raw.forEach((t, i) => {
    const n = i + 1;
    if (open) {
      const close = new RegExp(
        `^ {0,3}${open.marker[0] === "`" ? "`" : "~"}{${open.marker.length},}\\s*$`,
      );
      if (close.test(t)) {
        fences.push({
          info: open.info,
          openLine: open.openLine,
          body: open.body.join("\n"),
          index: open.index,
        });
        open = null;
      } else {
        open.body.push(t);
      }
      lines.push({ n, text: t, inFence: true });
      return;
    }
    const f = FENCE_OPEN.exec(t);
    if (f && !(f[1]?.startsWith("`") && f[2]?.includes("`"))) {
      const info = (f[2] ?? "").trim().split(/\s+/)[0] ?? "";
      open = { marker: f[1] ?? "```", info, openLine: n, index: i, body: [] };
      lines.push({ n, text: t, inFence: true });
      return;
    }
    const h = HEADING.exec(t);
    if (h) {
      const content = (h[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      headings.push({ level: h[1]?.length ?? 1, text: content, line: n, index: i });
    }
    lines.push({ n, text: t, inFence: false });
  });
  return {
    lines,
    headings,
    fences,
    unclosedFence: open ? (open as { openLine: number }).openLine : null,
  };
}

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The heading ending a section that starts at `h`: the next heading at the same or a higher level. */
function sectionEnd(s: Scan, h: Heading): number {
  const next = s.headings.find((x) => x.index > h.index && x.level <= h.level);
  return next ? next.index : s.lines.length;
}

function linesBetween(s: Scan, from: number, to: number): Line[] {
  return s.lines.slice(from + 1, to);
}

function listItems(lines: Line[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.inFence) continue;
    const m = LIST_ITEM.exec(l.text);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

const isNonEmptyStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim() !== "");

const EXPECT_RE = /^exit\s+\d+$/;

/** Validates one task's `sddx` block. Errors are attributed to the block's opening fence line. */
export function parseTaskBlock(
  yamlText: string,
  line: number,
): { value?: Omit<SpecTask, "id" | "title" | "line">; errors: SpecError[] } {
  const err = (message: string): SpecError => ({ message, line });
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    const pos = (e as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
    return {
      errors: [
        {
          message: `invalid YAML: ${(e as Error).message.split("\n")[0]}`,
          line: pos ? line + pos : line,
        },
      ],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { errors: [err("sddx block must be a YAML mapping")] };
  }
  const r = raw as Record<string, unknown>;
  const errors: SpecError[] = [];
  for (const k of Object.keys(r)) {
    if (!(TASK_BLOCK_KEYS as readonly string[]).includes(k)) {
      errors.push(err(`unknown key "${k}" (allowed: ${TASK_BLOCK_KEYS.join(", ")})`));
    }
  }

  const o = r.oracle;
  if (o === undefined) {
    errors.push(err("task has no oracle; no oracle, no goal"));
  } else if (typeof o !== "object" || o === null || Array.isArray(o)) {
    errors.push(err("oracle: must be a mapping"));
  } else {
    const or = o as Record<string, unknown>;
    for (const k of Object.keys(or)) {
      if (!ORACLE_KEYS.has(k)) errors.push(err(`oracle: unknown key "${k}"`));
    }
    if (typeof or.type !== "string" || !ORACLE_TYPES.has(or.type)) {
      errors.push(err("oracle.type: must be one of command | test-suite | browser | manual"));
    }
    if (or.type !== "manual") {
      if (typeof or.run !== "string" || or.run.trim() === "") {
        errors.push(err("oracle.run: a command is required for non-manual oracles"));
      }
      if (typeof or.expect !== "string" || !EXPECT_RE.test(or.expect.trim())) {
        errors.push(err('oracle.expect: must be `exit <code>`, for example "exit 0"'));
      }
    }
    if (
      or.runs !== undefined &&
      (typeof or.runs !== "number" || !Number.isInteger(or.runs) || or.runs < 1)
    ) {
      errors.push(err("oracle.runs: must be an integer >= 1"));
    }
    if (or.setup !== undefined && (typeof or.setup !== "string" || or.setup.trim() === "")) {
      errors.push(err("oracle.setup: when present, must be a non-empty command"));
    }
  }

  if (r.scope !== undefined && !isNonEmptyStringList(r.scope)) {
    errors.push(err("scope: when present, must be a non-empty list of non-empty globs"));
  }
  let dependsOn: string[] = [];
  if (r.depends_on !== undefined) {
    if (typeof r.depends_on === "string" && TASK_ID_RE.test(r.depends_on.trim())) {
      dependsOn = [r.depends_on.trim()];
    } else if (
      isNonEmptyStringList(r.depends_on) &&
      r.depends_on.every((d) => TASK_ID_RE.test(d.trim()))
    ) {
      dependsOn = r.depends_on.map((d) => d.trim());
    } else {
      errors.push(err("depends_on: must be a task id or a non-empty list of task ids"));
    }
  }
  if (
    r.on_dependency_failure !== undefined &&
    r.on_dependency_failure !== "skip" &&
    r.on_dependency_failure !== "block"
  ) {
    errors.push(err("on_dependency_failure: must be one of skip | block"));
  }
  if (r.assumptions !== undefined && !isNonEmptyStringList(r.assumptions)) {
    errors.push(err("assumptions: when present, must be a non-empty list of non-empty strings"));
  }
  const retryRaw = r.retry;
  let retry: Partial<RetryPolicy> | undefined;
  if (retryRaw !== undefined) {
    if (typeof retryRaw !== "object" || retryRaw === null || Array.isArray(retryRaw)) {
      errors.push(err("retry: must be a mapping with optional max_attempts and workspace"));
    } else {
      const rr = retryRaw as Record<string, unknown>;
      retry = {};
      if (rr.max_attempts !== undefined) {
        if (
          typeof rr.max_attempts !== "number" ||
          !Number.isInteger(rr.max_attempts) ||
          rr.max_attempts < 1
        ) {
          errors.push(err("retry.max_attempts: must be an integer >= 1"));
        } else retry.max_attempts = rr.max_attempts;
      }
      if (rr.workspace !== undefined) {
        if (rr.workspace !== "fresh" && rr.workspace !== "reuse") {
          errors.push(err("retry.workspace: must be one of fresh | reuse"));
        } else retry.workspace = rr.workspace;
      }
    }
  }
  if (errors.length > 0) return { errors };

  const or = o as Record<string, unknown>;
  return {
    errors: [],
    value: {
      oracle: {
        type: or.type as OracleType,
        run: typeof or.run === "string" ? or.run.trim() : "",
        expect: typeof or.expect === "string" ? or.expect.trim() : "exit 0",
        ...(typeof or.runs === "number" ? { runs: or.runs } : {}),
        ...(typeof or.setup === "string" ? { setup: or.setup.trim() } : {}),
      },
      scope: Array.isArray(r.scope) ? (r.scope as string[]).map((s) => s.trim()) : [],
      depends_on: dependsOn,
      ...(r.on_dependency_failure !== undefined
        ? { on_dependency_failure: r.on_dependency_failure as DependencyFailurePolicy }
        : {}),
      ...(retry ? { retry } : {}),
      assumptions: Array.isArray(r.assumptions)
        ? (r.assumptions as string[]).map((s) => s.trim())
        : [],
    },
  };
}

export function parseGoalSpec(text: string): ParseResult {
  const s = scan(text);
  const errors: SpecError[] = [];
  if (s.unclosedFence !== null) {
    errors.push({ message: "code fence is never closed", line: s.unclosedFence });
  }

  const firstContent = s.lines.find((l) => l.text.trim() !== "");
  const h1 = s.headings.find((h) => h.level === 1);
  let title = "";
  if (!firstContent || !h1 || h1.line !== firstContent.n || h1.text === "") {
    errors.push({ message: "the file must start with a level-1 heading naming the goal", line: 1 });
  } else {
    title = h1.text;
  }

  const h2 = (name: string): Heading[] =>
    s.headings.filter((h) => h.level === 2 && norm(h.text) === norm(name));
  const designs = h2("Design");
  const taskSections = h2("Tasks");
  for (const extra of designs.slice(1)) {
    errors.push({ message: "duplicate `## Design` section", line: extra.line });
  }
  for (const extra of taskSections.slice(1)) {
    errors.push({ message: "duplicate `## Tasks` section", line: extra.line });
  }
  const design = designs[0];
  const tasksHeading = taskSections[0];

  const content: Record<DesignSection, Line[] | null> = {
    Goal: null,
    Acceptance: null,
    "Non-goals": null,
    Assumptions: null,
    "Open decisions": null,
  };
  if (!design) {
    errors.push({ message: "missing `## Design` section", line: null });
  } else {
    if (tasksHeading && tasksHeading.index < design.index) {
      errors.push({ message: "`## Tasks` must come after `## Design`", line: tasksHeading.line });
    }
    const end = sectionEnd(s, design);
    const subs = s.headings.filter((h) => h.level === 3 && h.index > design.index && h.index < end);
    for (const sub of subs) {
      const name = DESIGN_SECTIONS.find((d) => norm(d) === norm(sub.text));
      if (!name) continue;
      if (content[name] !== null) {
        errors.push({ message: `duplicate \`### ${name}\` subsection`, line: sub.line });
        continue;
      }
      content[name] = linesBetween(s, sub.index, sectionEnd(s, sub));
    }
    for (const name of DESIGN_SECTIONS) {
      if (content[name] === null) {
        errors.push({ message: `## Design is missing \`### ${name}\``, line: design.line });
      }
    }
  }

  const goalText = (content.Goal ?? [])
    .filter((l) => !l.inFence && l.text.trim() !== "")
    .map((l) => l.text.trim())
    .join(" ");
  if (content.Goal && goalText === "") {
    errors.push({ message: "`### Goal` must not be empty", line: design?.line ?? null });
  }
  const acceptance = listItems(content.Acceptance ?? []);
  if (content.Acceptance && acceptance.length === 0) {
    errors.push({
      message: "`### Acceptance` needs at least one list item",
      line: design?.line ?? null,
    });
  }

  const tasks: SpecTask[] = [];
  if (tasksHeading) {
    const end = sectionEnd(s, tasksHeading);
    const taskHeadings = s.headings.filter(
      (h) => h.level === 3 && h.index > tasksHeading.index && h.index < end,
    );
    const seen = new Map<string, number>();
    for (const th of taskHeadings) {
      const m = /^(\S+)\s+(.+)$/.exec(th.text);
      if (!m?.[1] || !m[2] || !TASK_ID_RE.test(m[1])) {
        errors.push({
          message: "task heading must be `### <task-id> <title>` with an id like T1 or rl-1",
          line: th.line,
        });
        continue;
      }
      const [, id, title] = m;
      const prior = seen.get(id);
      if (prior !== undefined) {
        errors.push({
          message: `duplicate task id ${id} (lines ${prior} and ${th.line})`,
          line: th.line,
        });
        continue;
      }
      seen.set(id, th.line);
      const tEnd = sectionEnd(s, th);
      const blocks = s.fences.filter(
        (f) => f.info === "sddx" && f.index > th.index && f.index < tEnd,
      );
      if (blocks.length === 0) {
        errors.push({ message: `task ${id} has no \`sddx\` block`, line: th.line });
        continue;
      }
      if (blocks.length > 1) {
        errors.push({ message: `task ${id} has more than one \`sddx\` block`, line: th.line });
        continue;
      }
      const block = blocks[0] as Fence;
      const parsed = parseTaskBlock(block.body, block.openLine);
      if (!parsed.value) {
        for (const e of parsed.errors)
          errors.push({ message: `task ${id}: ${e.message}`, line: e.line });
        continue;
      }
      tasks.push({ id, title: title.trim(), line: th.line, ...parsed.value });
    }
    const stray = s.fences.filter(
      (f) =>
        f.info === "sddx" &&
        f.index > tasksHeading.index &&
        f.index < end &&
        !taskHeadings.some((th) => th.index < f.index),
    );
    for (const f of stray) {
      errors.push({ message: "`sddx` block outside any task heading", line: f.openLine });
    }
  }

  if (errors.length > 0) return { errors: errors.sort(byLine) };
  const openDecisions = listItems(content["Open decisions"] ?? []);
  return {
    errors: [],
    spec: {
      title,
      design: {
        goal: goalText,
        acceptance,
        nonGoals: listItems(content["Non-goals"] ?? []),
        assumptions: listItems(content.Assumptions ?? []),
        openDecisions,
      },
      status: openDecisions.length > 0 ? "draft" : "ready",
      tasks,
    },
  };
}

const byLine = (a: SpecError, b: SpecError): number => (a.line ?? 0) - (b.line ?? 0);

export const formatSpecError = (path: string, e: SpecError): string =>
  e.line === null ? `${path}: ${e.message}` : `${path}:${e.line}: ${e.message}`;
