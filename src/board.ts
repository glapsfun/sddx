// Deterministic BOARD.md renderer: pure filesystem reads over the workspace's
// .sddx plus each worktree's own task file. Same inputs, same bytes — rows are
// id-sorted and the output carries no timestamps, so idle regeneration never
// dirties the working tree.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stuckThreshold } from "./lib/config";
import type { Receipt } from "./lib/receipt";
import { blockedOn, dependsOnList, isV6Task, type TaskState } from "./lib/task";
import { worktreesDir } from "./lib/worktree";

interface BoardRow {
  id: string;
  goal: string;
  /** The task's v6 state, or UNREADABLE. */
  state: string;
  stuck: boolean;
  dependsOn?: string[];
  title: string;
  attempt: string;
  iterations: string;
  receipt: string;
  /** Abandon reason, else the strict-profile allow list. */
  note: string;
}

const DASH = "-";

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function receiptRef(dir: string, id: string): string {
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return DASH;
  try {
    return `#${(JSON.parse(readFileSync(path, "utf8")) as Receipt).seq}`;
  } catch {
    return "unreadable";
  }
}

function taskRow(
  taskPath: string,
  id: string,
  receiptsDirs: string[],
  threshold: number,
): BoardRow {
  let t: TaskState;
  try {
    t = JSON.parse(readFileSync(taskPath, "utf8")) as TaskState;
    // task files are untrusted here, and the board must keep working on them
    if (!isV6Task(t)) throw new Error("not a v6 task file");
  } catch {
    return {
      id,
      goal: DASH,
      state: "UNREADABLE",
      stuck: false,
      title: "task file failed to parse, or was written by sddx 5",
      attempt: DASH,
      iterations: DASH,
      receipt: DASH,
      note: DASH,
    };
  }
  let receipt = DASH;
  for (const dir of receiptsDirs) {
    receipt = receiptRef(dir, id);
    if (receipt !== DASH) break;
  }
  const deps = dependsOnList(t);
  const note =
    t.phase === "ABANDONED" && t.abandon_reason
      ? t.abandon_reason
      : t.allow.length > 0
        ? `allow: ${t.allow.join(", ")}`
        : DASH;
  return {
    id: t.id,
    goal: t.goal_id,
    state: t.phase,
    stuck: Boolean(t.stuck && t.stuck.count >= threshold),
    ...(deps.length > 0 ? { dependsOn: deps } : {}),
    title: t.task,
    attempt: String(t.attempt_count),
    iterations: String(t.iterations),
    receipt,
    note,
  };
}

interface FlagState {
  entries: Array<{ path: string; reason: string }>;
  unreadable: boolean;
}

/** Reads and sorts (by path) the skipped-worktree entries from `.sddx/sweep.json`. */
function readFlagState(cwd: string): FlagState {
  const path = join(cwd, ".sddx", "sweep.json");
  if (!existsSync(path)) return { entries: [], unreadable: false };
  let entries: Array<{ path: string; reason: string }>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { skipped?: unknown };
    entries = Array.isArray(parsed.skipped)
      ? (parsed.skipped as Array<{ path: string; reason: string }>)
      : [];
  } catch {
    return { entries: [], unreadable: true };
  }
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: sorted, unreadable: false };
}

/** "Flagged worktrees" section from .sddx/sweep.json; empty when nothing is flagged. */
function flagLines(state: FlagState): string[] {
  if (state.unreadable) {
    return [
      "## Flagged worktrees",
      "",
      "- sweep state unreadable: `.sddx/sweep.json` failed to parse",
      "",
    ];
  }
  if (state.entries.length === 0) return [];
  return [
    "## Flagged worktrees",
    "",
    ...state.entries.map((e) => `- \`${cell(String(e.path))}\`: ${cell(String(e.reason))}`),
    "",
  ];
}

const jsonIds = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort()
    : [];

function collectRows(cwd: string): Map<string, BoardRow> {
  const rows = new Map<string, BoardRow>();
  const mainReceipts = join(cwd, ".sddx", "receipts");
  const threshold = stuckThreshold(cwd);

  for (const id of jsonIds(join(cwd, ".sddx", "tasks"))) {
    rows.set(id, taskRow(join(cwd, ".sddx", "tasks", `${id}.json`), id, [mainReceipts], threshold));
  }
  // worktree copies are the live ones — they win over a same-id workspace row
  const wtDir = worktreesDir(cwd);
  if (existsSync(wtDir)) {
    for (const id of readdirSync(wtDir).sort()) {
      const taskPath = join(wtDir, id, ".sddx", "tasks", `${id}.json`);
      if (!existsSync(taskPath)) continue;
      // stuck is judged by the main checkout's config, the one verify reads
      rows.set(
        id,
        taskRow(taskPath, id, [join(wtDir, id, ".sddx", "receipts"), mainReceipts], threshold),
      );
    }
  }
  return rows;
}

export interface BoardTaskData extends BoardRow {
  label: string;
  blockedOnId: string | null;
}

export interface BoardData {
  tasks: BoardTaskData[];
  flaggedWorktrees: Array<{ path: string; reason: string }>;
  flaggedWorktreesUnreadable: boolean;
}

/** The state plus derived flags: stuck, and for a PLANNED task the dependency it waits on. */
function labelFor(cwd: string, r: BoardRow): { label: string; blockedOnId: string | null } {
  let label = r.state;
  if (r.stuck) label += " stuck";
  let blockedOnId: string | null = null;
  if (r.state === "PLANNED" && r.dependsOn) {
    blockedOnId = blockedOn(cwd, { id: r.id, depends_on: r.dependsOn });
    if (blockedOnId) label += ` blocked-on-${blockedOnId}`;
  }
  return { label, blockedOnId };
}

function boardDataFromRows(cwd: string, rows: Map<string, BoardRow>, flags: FlagState): BoardData {
  const tasks = [...rows.keys()].sort().map((id) => {
    const r = rows.get(id) as BoardRow;
    return { ...r, ...labelFor(cwd, r) };
  });
  return { tasks, flaggedWorktrees: flags.entries, flaggedWorktreesUnreadable: flags.unreadable };
}

function renderBoardFromRows(cwd: string, rows: Map<string, BoardRow>, flags: FlagState): string {
  const lines = ["<!-- generated by sddx, do not edit -->", "", "# sddx board", ""];
  if (rows.size === 0) {
    lines.push("_No tasks registered._", "");
  } else {
    lines.push(
      "| Task | Goal | State | Depends | Title | Attempt | Iter | Receipt | Note |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const id of [...rows.keys()].sort()) {
      const r = rows.get(id) as BoardRow;
      const { label } = labelFor(cwd, r);
      const depends = r.dependsOn && r.dependsOn.length > 0 ? cell(r.dependsOn.join(", ")) : DASH;
      lines.push(
        `| ${cell(r.id)} | ${cell(r.goal)} | ${label} | ${depends} | ${cell(r.title)} | ${r.attempt} | ${r.iterations} | ${r.receipt} | ${cell(r.note)} |`,
      );
    }
    lines.push("");
  }
  lines.push(...flagLines(flags));
  return lines.join("\n");
}

/** Structured board content — the same rows/flags `renderBoard` turns into
 * Markdown, for JSON/Markdown rendering through the shared output framework.
 * `phase` carries the same `⏸blocked-on-<id>` suffix `renderBoard`'s table
 * shows (so a generic Markdown table needs no board-specific knowledge to
 * stay consistent with `.sddx/BOARD.md`); `blockedOnId` is the same fact as
 * a bare id, for JSON consumers that want to key off it directly. */
export function boardData(cwd: string): BoardData {
  return boardDataFromRows(cwd, collectRows(cwd), readFlagState(cwd));
}

export function renderBoard(cwd: string): string {
  return renderBoardFromRows(cwd, collectRows(cwd), readFlagState(cwd));
}

export const boardPath = (cwd: string): string => join(cwd, ".sddx", "BOARD.md");

/** Write only when the rendered bytes differ; returns whether a write happened. */
export function writeBoard(cwd: string): { path: string; changed: boolean } {
  const { path, changed } = computeBoard(cwd);
  return { path, changed };
}

/** One scan of `.sddx/tasks`, worktrees, and `sweep.json` shared by both the
 * `.sddx/BOARD.md` write and the structured JSON/Markdown data — `sddx board`
 * used to call `writeBoard` and `boardData` separately, each re-scanning
 * every task/receipt file across the main checkout and every worktree. */
export function computeBoard(cwd: string): { path: string; changed: boolean; data: BoardData } {
  const rows = collectRows(cwd);
  const flags = readFlagState(cwd);
  const rendered = renderBoardFromRows(cwd, rows, flags);
  const path = boardPath(cwd);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  let changed = false;
  if (current !== rendered) {
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(path, rendered);
    changed = true;
  }
  return { path, changed, data: boardDataFromRows(cwd, rows, flags) };
}
