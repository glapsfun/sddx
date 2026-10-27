// `sddx migrate`: moves a repository from sddx 5 to 6. It never loses in-flight
// work (it refuses while any v5 task or goal is unfinished), removes only what
// sddx 5 provably generated, and never touches receipts, approval tokens or goal
// refs, so the receipt chain keeps auditing across the boundary.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_SCHEMA_VERSION, configPath } from "./config";
import {
  readV5Manifest,
  unmergeV5Settings,
  V5_DECLARATION_PATH,
  V5_OWNED,
  V5_SETTINGS_PATH,
  v5Ownership,
} from "./legacy/v5-claude";
import { isV6Task } from "./task";

export const LEGACY_DIR = ".sddx/legacy";
const TERMINAL = new Set(["DONE", "ABANDONED"]);
const REMOVED_KEYS = ["runtime_scope", "package_manager", "adapters"];

export interface V5Task {
  id: string;
  phase: string;
  /** Repository-relative path of the state file. */
  path: string;
  inWorktree: boolean;
}

export interface V5State {
  configVersion: string | null;
  tasks: V5Task[];
  specYamls: string[];
  dirsToArchive: string[];
  goalsInFlight: Array<{ id: string; outstanding: string[] }>;
  claudeOwned: string[];
  claudeModified: string[];
  settingsHooks: number;
  declaration: boolean;
  packageDependency: boolean;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function v5TasksIn(root: string, dir: string, inWorktree: boolean): V5Task[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: V5Task[] = [];
  for (const f of readdirSync(abs).filter((n) => n.endsWith(".json"))) {
    const raw = readJson(join(abs, f));
    if (raw === null || isV6Task(raw)) continue;
    const phase = String((raw as { phase?: unknown }).phase ?? "unknown");
    out.push({ id: f.slice(0, -".json".length), phase, path: `${dir}/${f}`, inWorktree });
  }
  return out;
}

function v5Goals(root: string): Array<{ id: string; task_ids: string[] }> {
  const r = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd: root,
    encoding: "utf8",
  });
  const goals: Array<{ id: string; task_ids: string[] }> = [];
  for (const ref of (r.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (!ref.startsWith("refs/sddx/goals/")) continue;
    const blob = spawnSync("git", ["cat-file", "-p", ref], { cwd: root, encoding: "utf8" });
    try {
      const g = JSON.parse(blob.stdout ?? "") as {
        id: string;
        task_ids?: string[];
        spec_path?: string;
      };
      if (g.spec_path === undefined) goals.push({ id: g.id, task_ids: g.task_ids ?? [] });
    } catch {
      // an unreadable record is not this command's to judge
    }
  }
  return goals;
}

/** A v5 task's phase wherever it lives: worktree, main checkout, or its branch tip. */
function v5Phase(root: string, id: string): string | null {
  for (const p of [
    join(root, ".sddx-worktrees", id, ".sddx", "tasks", `${id}.json`),
    join(root, ".sddx", "tasks", `${id}.json`),
  ]) {
    const raw = readJson(p);
    if (raw !== null) return String((raw as { phase?: unknown }).phase);
  }
  const r = spawnSync("git", ["show", `sddx/${id}:.sddx/tasks/${id}.json`], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return String((JSON.parse(r.stdout) as { phase?: unknown }).phase);
  } catch {
    return null;
  }
}

/** The part of the sddx 5 state that needs no git: enough for session start to
 * decide whether `sddx migrate` still has something to do. */
export type V5Signals = Pick<
  V5State,
  "configVersion" | "tasks" | "claudeOwned" | "claudeModified" | "settingsHooks" | "declaration"
>;

export function detectV5Signals(root: string): V5Signals {
  const cfg = readJson(configPath(root)) as { schema_version?: unknown } | null;
  const configVersion =
    cfg && typeof cfg.schema_version === "string" && cfg.schema_version.startsWith("1.")
      ? cfg.schema_version
      : null;

  const tasks = v5TasksIn(root, ".sddx/tasks", false);
  const wts = join(root, ".sddx-worktrees");
  if (existsSync(wts)) {
    for (const id of readdirSync(wts)) {
      tasks.push(
        ...v5TasksIn(root, `.sddx-worktrees/${id}/.sddx/tasks`, true).filter((t) => t.id === id),
      );
    }
  }

  const manifest = readV5Manifest(root);
  const claudeOwned: string[] = [];
  const claudeModified: string[] = [];
  for (const path of Object.keys(V5_OWNED)) {
    const o = v5Ownership(root, path, manifest);
    if (o === "owned") claudeOwned.push(path);
    else if (o === "modified") claudeModified.push(path);
  }
  let settingsHooks = 0;
  if (existsSync(join(root, V5_SETTINGS_PATH))) {
    settingsHooks = unmergeV5Settings(readFileSync(join(root, V5_SETTINGS_PATH), "utf8")).removed;
  }

  return {
    configVersion,
    tasks,
    claudeOwned,
    claudeModified,
    settingsHooks,
    declaration: existsSync(join(root, V5_DECLARATION_PATH)),
  };
}

export function detectV5State(root: string): V5State {
  const signals = detectV5Signals(root);

  const specDir = join(root, ".sddx", "specs");
  const specYamls = existsSync(specDir)
    ? readdirSync(specDir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => `.sddx/specs/${f}`)
    : [];
  const dirsToArchive = ["drafts", "context", "goals"]
    .map((d) => `.sddx/${d}`)
    .filter(
      (d) => existsSync(join(root, d)) && readdirSync(join(root, d)).some((f) => f !== ".gitkeep"),
    );

  const goalsInFlight = v5Goals(root)
    .map((g) => ({
      id: g.id,
      outstanding: g.task_ids.filter((id) => !TERMINAL.has(v5Phase(root, id) ?? "missing")),
    }))
    .filter((g) => g.outstanding.length > 0);

  const pkg = readJson(join(root, "package.json")) as Record<
    string,
    Record<string, unknown>
  > | null;
  const packageDependency = Boolean(
    pkg &&
      ["dependencies", "devDependencies"].some((k) => pkg[k]?.["@glapsfun/sddx"] !== undefined),
  );

  return { ...signals, specYamls, dirsToArchive, goalsInFlight, packageDependency };
}

/** What makes v6 commands refuse: a v5 config, a v5 task file in the main
 * checkout, or an unfinished v5 task in a worktree. */
export function v5Blockers(s: Pick<V5State, "configVersion" | "tasks">): string[] {
  const out: string[] = [];
  if (s.configVersion) out.push(`.sddx/config.json has schema_version ${s.configVersion}`);
  for (const t of s.tasks) {
    if (!t.inWorktree || !TERMINAL.has(t.phase)) out.push(`v5 task state ${t.path}`);
  }
  return out;
}

export function inFlight(s: V5State): string[] {
  const out = s.tasks
    .filter((t) => !TERMINAL.has(t.phase))
    .map((t) => `task ${t.id} is ${t.phase} (${t.path})`);
  for (const g of s.goalsInFlight) {
    out.push(`goal ${g.id} has unfinished tasks: ${g.outstanding.join(", ")}`);
  }
  return [...new Set(out)];
}

export interface MigrationAction {
  kind: "remove" | "move" | "rewrite" | "keep" | "manual";
  path: string;
  detail: string;
}

export function planMigration(s: V5State): MigrationAction[] {
  const actions: MigrationAction[] = [];
  for (const p of s.claudeOwned) {
    actions.push({ kind: "remove", path: p, detail: "generated by sddx 5, unmodified" });
  }
  for (const p of s.claudeModified) {
    actions.push({
      kind: "keep",
      path: p,
      detail: "generated by sddx 5 but edited since; remove it by hand",
    });
  }
  if (s.settingsHooks > 0) {
    actions.push({
      kind: "rewrite",
      path: V5_SETTINGS_PATH,
      detail: `remove ${s.settingsHooks} sddx hook entr${s.settingsHooks === 1 ? "y" : "ies"}, keep everything else`,
    });
  }
  if (s.declaration) {
    actions.push({
      kind: "remove",
      path: V5_DECLARATION_PATH,
      detail: "sddx 5 adapter declaration",
    });
  }
  for (const d of s.dirsToArchive) {
    actions.push({ kind: "move", path: d, detail: `to ${LEGACY_DIR}/${d.slice(".sddx/".length)}` });
  }
  for (const t of s.tasks.filter((x) => !x.inWorktree)) {
    actions.push({ kind: "move", path: t.path, detail: `to ${LEGACY_DIR}/tasks/` });
  }
  for (const p of s.specYamls) {
    actions.push({ kind: "move", path: p, detail: `to ${LEGACY_DIR}/specs/` });
  }
  if (s.configVersion) {
    actions.push({
      kind: "rewrite",
      path: ".sddx/config.json",
      detail: `schema_version ${CONFIG_SCHEMA_VERSION}, drop ${REMOVED_KEYS.join(", ")}`,
    });
  }
  if (s.packageDependency) {
    actions.push({
      kind: "manual",
      path: "package.json",
      detail:
        "lists @glapsfun/sddx; remove it or upgrade it to 6 yourself (migrate never edits package manifests)",
    });
  }
  return actions;
}

function move(root: string, from: string, to: string): void {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(join(root, from), dest);
}

/** Applies a migration plan. Receipts, approval tokens and goal refs are never in it. */
export function applyMigration(root: string, s: V5State): void {
  for (const p of s.claudeOwned) rmSync(join(root, p), { force: true });
  for (const p of s.claudeOwned) {
    const dir = dirname(join(root, p));
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
  if (s.settingsHooks > 0) {
    const path = join(root, V5_SETTINGS_PATH);
    writeFileSync(path, unmergeV5Settings(readFileSync(path, "utf8")).text);
  }
  if (s.declaration) rmSync(join(root, V5_DECLARATION_PATH), { force: true });
  for (const d of s.dirsToArchive) move(root, d, `${LEGACY_DIR}/${d.slice(".sddx/".length)}`);
  for (const t of s.tasks.filter((x) => !x.inWorktree)) {
    move(root, t.path, `${LEGACY_DIR}/tasks/${t.id}.json`);
  }
  for (const p of s.specYamls)
    move(root, p, `${LEGACY_DIR}/specs/${p.slice(".sddx/specs/".length)}`);
  if (s.configVersion) {
    const cfg = readJson(configPath(root)) as Record<string, unknown>;
    const next: Record<string, unknown> = { schema_version: CONFIG_SCHEMA_VERSION };
    for (const [k, v] of Object.entries(cfg)) {
      if (k === "schema_version" || REMOVED_KEYS.includes(k)) continue;
      next[k] = v;
    }
    writeFileSync(configPath(root), `${JSON.stringify(next, null, 2)}\n`);
  }
}

export const nothingToDo = (actions: MigrationAction[]): boolean =>
  actions.every((a) => a.kind === "keep" || a.kind === "manual");
