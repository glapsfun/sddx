// Deterministic BOARD.md renderer: pure filesystem reads over the workspace's
// .sddx plus each worktree's own task file. Same inputs, same bytes — rows are
// id-sorted and the output carries no timestamps, so idle regeneration never
// dirties the working tree.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stuckThreshold } from "./lib/config";
import type { Receipt } from "./lib/receipt";
import { blockedOn, type TaskState } from "./lib/task";
import { worktreesDir } from "./lib/worktree";

interface BoardRow {
  id: string;
  phase: string;
  rawPhase: string;
  dependsOn?: string;
  sentence: string;
  workspace: string;
  branch: string | null;
  iterations: string;
  receipt: string;
  allow: string;
}

const DASH = "—";

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
  } catch {
    return {
      id,
      phase: "UNREADABLE",
      rawPhase: "UNREADABLE",
      sentence: "task file failed to parse",
      workspace: DASH,
      branch: null,
      iterations: DASH,
      receipt: DASH,
      allow: DASH,
    };
  }
  let receipt = DASH;
  for (const dir of receiptsDirs) {
    receipt = receiptRef(dir, id);
    if (receipt !== DASH) break;
  }
  return {
    id: t.id,
    phase: t.stuck && t.stuck.count >= threshold ? `${t.phase} ⚠stuck` : t.phase,
    rawPhase: t.phase,
    ...(t.depends_on ? { dependsOn: t.depends_on } : {}),
    sentence: t.task,
    workspace: t.workspace.mode,
    branch: t.workspace.branch,
    iterations: String(t.iterations),
    receipt,
    allow: t.allow.length > 0 ? t.allow.join(", ") : DASH,
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
      "- sweep state unreadable — `.sddx/sweep.json` failed to parse",
      "",
    ];
  }
  if (state.entries.length === 0) return [];
  return [
    "## Flagged worktrees",
    "",
    ...state.entries.map((e) => `- \`${cell(String(e.path))}\` — ${cell(String(e.reason))}`),
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
      // worktrees carry their own .sddx/config.json — judge stuck by the same
      // threshold the gates inside that worktree use
      rows.set(
        id,
        taskRow(
          taskPath,
          id,
          [join(wtDir, id, ".sddx", "receipts"), mainReceipts],
          stuckThreshold(join(wtDir, id)),
        ),
      );
    }
  }
  return rows;
}

export interface BoardTaskData extends BoardRow {
  blockedOnId: string | null;
}

export interface BoardData {
  tasks: BoardTaskData[];
  flaggedWorktrees: Array<{ path: string; reason: string }>;
  flaggedWorktreesUnreadable: boolean;
}

/** Same fact `renderBoard`'s table shows inline: null once a task is DONE
 * (nothing can still block it), otherwise the nearest non-DONE ancestor. */
function blockedOnId(cwd: string, r: BoardRow, id: string): string | null {
  return r.rawPhase === "DONE" ? null : blockedOn(cwd, { id, depends_on: r.dependsOn });
}

function boardDataFromRows(cwd: string, rows: Map<string, BoardRow>, flags: FlagState): BoardData {
  const tasks = [...rows.keys()].sort().map((id) => {
    const r = rows.get(id) as BoardRow;
    const blocker = blockedOnId(cwd, r, id);
    const phase = blocker ? `${r.phase} ⏸blocked-on-${blocker}` : r.phase;
    return { ...r, phase, blockedOnId: blocker };
  });
  return { tasks, flaggedWorktrees: flags.entries, flaggedWorktreesUnreadable: flags.unreadable };
}

function renderBoardFromRows(cwd: string, rows: Map<string, BoardRow>, flags: FlagState): string {
  const lines = ["<!-- generated by sddx — do not edit -->", "", "# sddx board", ""];
  if (rows.size === 0) {
    lines.push("_No tasks registered._", "");
  } else {
    lines.push(
      "| Task | Phase | Depends | Sentence | Workspace | Iter | Receipt | Allow |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const id of [...rows.keys()].sort()) {
      const r = rows.get(id) as BoardRow;
      // Share the CLI's blocked derivation so the board and `blockedOn` agree even
      // when an ancestor's worktree was swept (resolveTaskState reads its branch tip).
      const blocker = blockedOnId(cwd, r, id);
      const phase = blocker ? `${r.phase} ⏸blocked-on-${blocker}` : r.phase;
      lines.push(
        `| ${cell(r.id)} | ${phase} | ${r.dependsOn ? cell(r.dependsOn) : DASH} | ${cell(r.sentence)} | ${r.workspace} | ${r.iterations} | ${r.receipt} | ${cell(r.allow)} |`,
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
