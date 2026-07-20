import { createRequire } from "node:module";
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/hooks.ts
import { existsSync as existsSync8, readdirSync as readdirSync5, readFileSync as readFileSync7 } from "node:fs";
import { join as join8 } from "node:path";

// src/board.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/lib/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function readConfig(root) {
  const path = join(root, ".sddx", "config.json");
  if (!existsSync(path))
    return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
var positiveInt = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
function stuckThreshold(root, env = process.env) {
  return positiveInt(Number(env.SDDX_STUCK_THRESHOLD)) ?? positiveInt(readConfig(root).stuck_threshold) ?? 3;
}
function oracleRuns(root, specRuns, env = process.env) {
  return positiveInt(specRuns) ?? positiveInt(Number(env.SDDX_ORACLE_RUNS)) ?? positiveInt(readConfig(root).oracle_runs_default) ?? 1;
}

// src/lib/worktree.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import {
  appendFileSync,
  existsSync as existsSync2,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSync2,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join as join2, relative } from "node:path";

// src/lib/git.ts
import { spawnSync } from "node:child_process";
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error)
    throw new Error(`git not runnable: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}
var headSha = (cwd) => git(cwd, "rev-parse", "HEAD");
var currentBranch = (cwd) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
var createBranch = (cwd, name) => {
  git(cwd, "switch", "-c", name);
};
function branchExists(cwd, name) {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd
  });
  return r.status === 0;
}
function isMerged(cwd, branch) {
  return git(cwd, "branch", "--merged", "HEAD", "--format=%(refname:short)").split(`
`).includes(branch);
}
var deleteBranch = (cwd, name) => {
  git(cwd, "branch", "-d", name);
};
var forceDeleteBranch = (cwd, name) => {
  git(cwd, "branch", "-D", name);
};
function remoteUrl(cwd, remote) {
  const r = spawnSync("git", ["remote", "get-url", remote], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
var push = (cwd, branch) => {
  git(cwd, "push", "-u", "origin", branch);
};
var stageAll = (cwd) => {
  git(cwd, "add", "-A");
};
var stagePath = (cwd, path) => {
  git(cwd, "add", "--", path);
};
var writeTree = (cwd) => git(cwd, "write-tree");
function commit(cwd, message) {
  git(cwd, "commit", "-m", message);
  return headSha(cwd);
}

// src/lib/worktree.ts
var worktreesDir = (cwd) => join2(cwd, ".sddx-worktrees");
function tryRev(cwd, ref) {
  const r = spawnSync2("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd,
    encoding: "utf8"
  });
  return r.status === 0 ? r.stdout.trim() : null;
}
function resolveBaseRef(cwd) {
  const symref = spawnSync2("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8"
  });
  if (symref.status === 0) {
    const sha = tryRev(cwd, symref.stdout.trim());
    if (sha)
      return { sha, source: "origin/HEAD" };
  }
  for (const [ref, source] of [
    ["refs/remotes/origin/main", "origin/main"],
    ["refs/remotes/origin/master", "origin/master"]
  ]) {
    const sha = tryRev(cwd, ref);
    if (sha)
      return { sha, source };
  }
  return { sha: git(cwd, "rev-parse", "HEAD"), source: "HEAD" };
}
var gitCommonDir = (cwd) => {
  const dir = git(cwd, "rev-parse", "--git-common-dir");
  return join2(cwd, dir);
};
var EXCLUDE_LINE = ".sddx-worktrees/";
function ensureExcluded(cwd) {
  const infoDir = join2(gitCommonDir(cwd), "info");
  mkdirSync(infoDir, { recursive: true });
  const exclude = join2(infoDir, "exclude");
  const current = existsSync2(exclude) ? readFileSync2(exclude, "utf8") : "";
  if (current.split(`
`).includes(EXCLUDE_LINE))
    return;
  const sep = current === "" || current.endsWith(`
`) ? "" : `
`;
  appendFileSync(exclude, `${sep}${EXCLUDE_LINE}
`);
}
function worktreeAvailable(cwd) {
  const r = spawnSync2("git", ["worktree", "list"], { cwd });
  if (r.status !== 0)
    return false;
  const gitDir = git(cwd, "rev-parse", "--git-dir");
  const common = git(cwd, "rev-parse", "--git-common-dir");
  return gitDir === common;
}
function createWorktree(cwd, id, baseSha) {
  ensureExcluded(cwd);
  mkdirSync(worktreesDir(cwd), { recursive: true });
  const path = join2(worktreesDir(cwd), id);
  git(cwd, "worktree", "add", "-q", path, "-b", `sddx/${id}`, baseSha);
  return path;
}
var isDirty = (worktreePath) => git(worktreePath, "status", "--porcelain") !== "";
function removeWorktree(cwd, path) {
  git(cwd, "worktree", "remove", path);
  git(cwd, "worktree", "prune");
}
function removeWorktreeForced(cwd, path) {
  git(cwd, "worktree", "remove", "--force", path);
  git(cwd, "worktree", "prune");
}
function listSddxWorktrees(cwd) {
  const dir = worktreesDir(cwd);
  if (!existsSync2(dir))
    return [];
  const realPrefix = `${realpathSync(dir)}/`;
  const prefix = `${dir}/`;
  const out = git(cwd, "worktree", "list", "--porcelain");
  const entries = [];
  let current = {};
  for (const line of `${out}
`.split(`
`)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "" && current.path) {
      if (current.path.startsWith(realPrefix)) {
        current.path = prefix + current.path.slice(realPrefix.length);
        entries.push(current);
      }
      current = {};
    }
  }
  return entries;
}
function hasSubmodules(cwd, baseSha) {
  const r = spawnSync2("git", ["cat-file", "-e", `${baseSha}:.gitmodules`], { cwd });
  return r.status === 0;
}
var LOCK_STALE_MS = 10 * 60000;
function acquireLock(lockPath, now) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    let age = 0;
    try {
      age = now - statSync(lockPath).mtimeMs;
    } catch {
      try {
        mkdirSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    if (age <= LOCK_STALE_MS)
      return false;
    try {
      rmdirSync(lockPath);
      mkdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}
function readWorktreeTask(worktreePath, id) {
  const path = join2(worktreePath, ".sddx", "tasks", `${id}.json`);
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
var DISPOSABLE = new Set(["DONE", "ABANDONED"]);
function writeSweepState(cwd, skipped) {
  const entries = skipped.map((s) => ({ path: relative(cwd, s.path), reason: s.reason })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  mkdirSync(join2(cwd, ".sddx"), { recursive: true });
  writeFileSync(join2(cwd, ".sddx", "sweep.json"), `${JSON.stringify({ skipped: entries }, null, 2)}
`);
}
function sweep(cwd, opts = {}) {
  const now = opts.now ?? Date.now();
  const lockPath = join2(gitCommonDir(cwd), "sddx-sweep.lock");
  if (!acquireLock(lockPath, now)) {
    return { removed: [], skipped: [], locked: true };
  }
  const removed = [];
  const skipped = [];
  try {
    for (const wt of listSddxWorktrees(cwd)) {
      const id = wt.branch?.replace(/^sddx\//, "");
      if (!id) {
        skipped.push({ path: wt.path, reason: "no sddx branch" });
        continue;
      }
      const task = readWorktreeTask(wt.path, id);
      if (!task) {
        skipped.push({ path: wt.path, reason: "no readable task state" });
        continue;
      }
      if (!DISPOSABLE.has(task.phase)) {
        skipped.push({ path: wt.path, reason: `phase ${task.phase}` });
        continue;
      }
      if (isDirty(wt.path)) {
        skipped.push({ path: wt.path, reason: "dirty" });
        continue;
      }
      if (task.phase === "DONE" && !existsSync2(join2(wt.path, ".sddx", "receipts", `${id}.json`))) {
        skipped.push({ path: wt.path, reason: "DONE without receipt" });
        continue;
      }
      try {
        removeWorktree(cwd, wt.path);
        removed.push(wt.path);
      } catch (e) {
        skipped.push({ path: wt.path, reason: `remove failed: ${e.message}` });
      }
    }
    writeSweepState(cwd, skipped);
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {}
  }
  return { removed, skipped, locked: false };
}

// src/board.ts
var DASH = "—";
var cell = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function receiptRef(dir, id) {
  const path = join3(dir, `${id}.json`);
  if (!existsSync3(path))
    return DASH;
  try {
    return `#${JSON.parse(readFileSync3(path, "utf8")).seq}`;
  } catch {
    return "unreadable";
  }
}
function taskRow(taskPath, id, receiptsDirs, threshold) {
  let t;
  try {
    t = JSON.parse(readFileSync3(taskPath, "utf8"));
  } catch {
    return {
      id,
      phase: "UNREADABLE",
      sentence: "task file failed to parse",
      workspace: DASH,
      iterations: DASH,
      receipt: DASH,
      allow: DASH
    };
  }
  let receipt = DASH;
  for (const dir of receiptsDirs) {
    receipt = receiptRef(dir, id);
    if (receipt !== DASH)
      break;
  }
  return {
    id: t.id,
    phase: t.stuck && t.stuck.count >= threshold ? `${t.phase} ⚠stuck` : t.phase,
    sentence: t.task,
    workspace: t.workspace.mode,
    iterations: String(t.iterations),
    receipt,
    allow: t.allow.length > 0 ? t.allow.join(", ") : DASH
  };
}
function flagLines(cwd) {
  const path = join3(cwd, ".sddx", "sweep.json");
  if (!existsSync3(path))
    return [];
  let entries;
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    entries = Array.isArray(parsed.skipped) ? parsed.skipped : [];
  } catch {
    return [
      "## Flagged worktrees",
      "",
      "- sweep state unreadable — `.sddx/sweep.json` failed to parse",
      ""
    ];
  }
  if (entries.length === 0)
    return [];
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return [
    "## Flagged worktrees",
    "",
    ...sorted.map((e) => `- \`${cell(String(e.path))}\` — ${cell(String(e.reason))}`),
    ""
  ];
}
var jsonIds = (dir) => existsSync3(dir) ? readdirSync2(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort() : [];
function renderBoard(cwd) {
  const rows = new Map;
  const mainReceipts = join3(cwd, ".sddx", "receipts");
  const threshold = stuckThreshold(cwd);
  for (const id of jsonIds(join3(cwd, ".sddx", "tasks"))) {
    rows.set(id, taskRow(join3(cwd, ".sddx", "tasks", `${id}.json`), id, [mainReceipts], threshold));
  }
  const wtDir = worktreesDir(cwd);
  if (existsSync3(wtDir)) {
    for (const id of readdirSync2(wtDir).sort()) {
      const taskPath = join3(wtDir, id, ".sddx", "tasks", `${id}.json`);
      if (!existsSync3(taskPath))
        continue;
      rows.set(id, taskRow(taskPath, id, [join3(wtDir, id, ".sddx", "receipts"), mainReceipts], stuckThreshold(join3(wtDir, id))));
    }
  }
  const lines = ["<!-- generated by sddx — do not edit -->", "", "# sddx board", ""];
  if (rows.size === 0) {
    lines.push("_No tasks registered._", "");
  } else {
    lines.push("| Task | Phase | Sentence | Workspace | Iter | Receipt | Allow |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const id of [...rows.keys()].sort()) {
      const r = rows.get(id);
      lines.push(`| ${cell(r.id)} | ${r.phase} | ${cell(r.sentence)} | ${r.workspace} | ${r.iterations} | ${r.receipt} | ${cell(r.allow)} |`);
    }
    lines.push("");
  }
  lines.push(...flagLines(cwd));
  return lines.join(`
`);
}
var boardPath = (cwd) => join3(cwd, ".sddx", "BOARD.md");
function writeBoard(cwd) {
  const path = boardPath(cwd);
  const rendered = renderBoard(cwd);
  const current = existsSync3(path) ? readFileSync3(path, "utf8") : null;
  if (current === rendered)
    return { path, changed: false };
  mkdirSync2(join3(cwd, ".sddx"), { recursive: true });
  writeFileSync2(path, rendered);
  return { path, changed: true };
}

// src/lib/resolve.ts
import { existsSync as existsSync5, readdirSync as readdirSync3, readFileSync as readFileSync5, statSync as statSync2 } from "node:fs";
import { basename, dirname, join as join5, resolve as resolvePath } from "node:path";

// src/lib/task.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/lib/glob.ts
function segmentToRegex(segment) {
  let out = "";
  for (const ch of segment) {
    if (ch === "*")
      out += "[^/]*";
    else if (ch === "?")
      out += "[^/]";
    else
      out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return out;
}
function globToRegExp(pattern) {
  const segments = pattern.split("/");
  let re = "^";
  for (let i = 0;i < segments.length; i++) {
    const last = i === segments.length - 1;
    if (segments[i] === "**") {
      re += last ? ".+" : "(?:[^/]+/)*";
    } else {
      re += segmentToRegex(segments[i]) + (last ? "" : "/");
    }
  }
  return new RegExp(`${re}$`);
}
var globMatch = (pattern, path) => globToRegExp(pattern).test(path);

// src/lib/classify.ts
var BUILTIN_EXEMPT_GLOBS = [
  ".sddx/**",
  "docs/**",
  "**/*.md",
  "package.json",
  "tsconfig.json",
  ".github/**",
  "openspec/**",
  ".claude/**"
];
var BUILTIN_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "tests/**",
  "test/**",
  "__tests__/**",
  "spec/**"
];
var splitGlobs = (value) => (value ?? "").split(/\s+/).filter((g) => g !== "");
var normalizeRelPath = (path) => path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
function classify(relPath, allow, config = {}) {
  const path = normalizeRelPath(relPath);
  for (const entry of allow) {
    if (normalizeRelPath(entry) === path)
      return { rule: "allow", pattern: entry };
  }
  for (const pattern of [...BUILTIN_EXEMPT_GLOBS, ...splitGlobs(config.exemptGlobs)]) {
    if (globMatch(pattern, path))
      return { rule: "exempt", pattern };
  }
  for (const pattern of [...BUILTIN_TEST_GLOBS, ...splitGlobs(config.testGlobs)]) {
    if (globMatch(pattern, path))
      return { rule: "test", pattern };
  }
  return { rule: "implementation", pattern: null };
}

// src/lib/task.ts
var TRANSITIONS = {
  PLAN: ["RED", "ABANDONED"],
  RED: ["GREEN", "ABANDONED"],
  GREEN: ["REFACTOR", "VERIFY", "ABANDONED"],
  REFACTOR: ["GREEN", "VERIFY", "ABANDONED"],
  VERIFY: ["DONE", "ABANDONED"],
  DONE: [],
  ABANDONED: []
};
var sddxDir = (cwd) => join4(cwd, ".sddx");
var taskPath = (cwd, id) => join4(sddxDir(cwd), "tasks", `${id}.json`);
function taskId(sentence, date = new Date) {
  const slug = sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${ymd}-${slug}`;
}
function createTask(cwd, spec, specPath, workspace) {
  const now = new Date().toISOString();
  const t = {
    id: taskId(spec.task),
    task: spec.task,
    phase: "PLAN",
    spec_path: specPath,
    oracle: spec.oracle,
    workspace,
    allow: [],
    iterations: 0,
    evidence: {},
    history: [{ phase: "PLAN", at: now }],
    created_at: now,
    updated_at: now
  };
  const path = taskPath(cwd, t.id);
  if (existsSync4(path))
    throw new Error(`task ${t.id} already exists at ${path}`);
  mkdirSync3(join4(sddxDir(cwd), "tasks"), { recursive: true });
  writeFileSync3(path, `${JSON.stringify(t, null, 2)}
`);
  return t;
}
function readTask(cwd, id) {
  const path = taskPath(cwd, id);
  if (!existsSync4(path))
    throw new Error(`no such task: ${id} (${path})`);
  return JSON.parse(readFileSync4(path, "utf8"));
}
function writeTask(cwd, t) {
  t.updated_at = new Date().toISOString();
  writeFileSync3(taskPath(cwd, t.id), `${JSON.stringify(t, null, 2)}
`);
}
function transition(t, to, opts = {}) {
  if (!TRANSITIONS[t.phase].includes(to)) {
    throw new Error(`illegal transition ${t.phase} → ${to}`);
  }
  const at = new Date().toISOString();
  const source = opts.source ?? "manual";
  if (to === "RED") {
    if (opts.testExit === undefined || opts.testExit === 0) {
      throw new Error("RED requires evidence of a failing test: --test-exit <nonzero exit code>");
    }
    t.evidence.red = { test_exit: opts.testExit, at, source };
  }
  if (to === "GREEN") {
    if (opts.testExit !== 0) {
      throw new Error("GREEN requires evidence of a passing test: --test-exit 0");
    }
    t.evidence.green = { test_exit: 0, at, source };
  }
  if (to === "DONE" && !opts.internal) {
    throw new Error("DONE is set by the verifier, not by phase transitions");
  }
  t.phase = to;
  t.history.push({ phase: to, at });
  return t;
}
var TERMINAL_PHASES = new Set(["DONE", "ABANDONED"]);
var isTerminal = (phase) => TERMINAL_PHASES.has(phase);
function allowPath(t, path) {
  if (isTerminal(t.phase)) {
    throw new Error(`task ${t.id} is ${t.phase}; allow-list is frozen on terminal tasks`);
  }
  const normalized = normalizeRelPath(path);
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`allow requires a repo-relative path, got: ${path}`);
  }
  if (!t.allow.includes(normalized))
    t.allow.push(normalized);
  return t;
}
function markShipped(t, goalId, prUrl) {
  t.shipped = { goal_id: goalId, pr_url: prUrl, at: new Date().toISOString() };
  return t;
}
function readTaskFrom(dir, id) {
  try {
    return JSON.parse(readFileSync4(taskPath(dir, id), "utf8"));
  } catch {
    return null;
  }
}
function readTaskFromBranch(cwd, id) {
  const r = spawnSync3("git", ["show", `sddx/${id}:.sddx/tasks/${id}.json`], {
    cwd,
    encoding: "utf8"
  });
  if (r.status !== 0)
    return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}
function resolveTaskState(cwd, id) {
  return readTaskFrom(join4(cwd, ".sddx-worktrees", id), id) ?? readTaskFrom(cwd, id) ?? readTaskFromBranch(cwd, id);
}

// src/lib/resolve.ts
function workspaceRoot(startPath) {
  let dir = resolvePath(startPath);
  try {
    if (statSync2(dir).isFile())
      dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  while (true) {
    if (existsSync5(join5(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function headBranch(root) {
  try {
    const dotGit = join5(root, ".git");
    let gitDir = dotGit;
    if (statSync2(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync5(dotGit, "utf8"));
      if (!m)
        return null;
      gitDir = resolvePath(root, m[1].trim());
    }
    const head = readFileSync5(join5(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : null;
  } catch {
    return null;
  }
}
function readTaskFile(root, id) {
  const path = join5(root, ".sddx", "tasks", `${id}.json`);
  if (!existsSync5(path))
    return null;
  try {
    return { kind: "task", root, task: JSON.parse(readFileSync5(path, "utf8")) };
  } catch (e) {
    return { kind: "corrupt", root, path, error: e.message };
  }
}
function resolutionFailureReason(res, action) {
  if (res.kind === "ambiguous") {
    return `sddx TDD gate: ambiguous governing task — ${res.ids.join(" and ")} are both active in this workspace. ` + "The gate refuses to guess. Abandon or finish one, or work in each task's own worktree.";
  }
  if (res.kind === "corrupt") {
    return `sddx TDD gate: task state at ${res.path} is unreadable (${res.error}). Fix or remove it before ${action} — a broken state file must not silently disable the gate.`;
  }
  return null;
}
function resolveTask(startPath) {
  const root = workspaceRoot(startPath);
  if (!root || !existsSync5(join5(root, ".sddx")))
    return { kind: "none" };
  if (basename(dirname(root)) === ".sddx-worktrees") {
    const byName = readTaskFile(root, basename(root));
    if (byName)
      return byName;
  }
  const branch = headBranch(root);
  if (branch?.startsWith("sddx/")) {
    const byBranch = readTaskFile(root, branch.slice("sddx/".length));
    if (byBranch)
      return byBranch;
  }
  const tasksDir = join5(root, ".sddx", "tasks");
  if (!existsSync5(tasksDir))
    return { kind: "none" };
  const candidates = [];
  for (const file of readdirSync3(tasksDir).filter((f) => f.endsWith(".json"))) {
    const path = join5(tasksDir, file);
    let task;
    try {
      task = JSON.parse(readFileSync5(path, "utf8"));
    } catch (e) {
      return { kind: "corrupt", root, path, error: e.message };
    }
    if (!isTerminal(task.phase))
      candidates.push(task);
  }
  if (candidates.length === 0)
    return { kind: "none" };
  if (candidates.length === 1)
    return { kind: "task", root, task: candidates[0] };
  return { kind: "ambiguous", root, ids: candidates.map((t) => t.id).sort() };
}

// src/lib/bashgate.ts
var BASH_ALLOW_BASE = [
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pytest",
  "go",
  "cargo",
  "make",
  "node",
  "python",
  "python3",
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "head",
  "tail",
  "wc"
];
var GIT_READ_SUBCOMMANDS = ["status", "diff", "log", "show"];
var EVAL_CAPABLE = new Set(["bun", "node", "npx", "python", "python3"]);
var EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--exec"]);
var splitList = (value) => (value ?? "").split(/\s+/).filter((s) => s !== "");
function commandWords(segment) {
  const words = segment.trim().split(/\s+/).filter((w) => w !== "");
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))
    i += 1;
  return words.slice(i);
}
var commandBasename = (word) => {
  const bare = word.replace(/^["']+|["']+$/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
};
function checkBashCommand(command, extraAllow) {
  if (/\$\(|`|<\(/.test(command)) {
    return {
      allow: false,
      reason: "command/process substitution executes arbitrary commands; the gate does not parse it"
    };
  }
  if (command.replace(/\d*>&\d+/g, "").includes(">")) {
    return {
      allow: false,
      reason: "redirection (>) writes files; the gate does not parse targets"
    };
  }
  const allowed = new Set([...BASH_ALLOW_BASE, ...extraAllow]);
  for (const segment of command.split(/\|\||&&|;|\||\r?\n/)) {
    const words = commandWords(segment);
    if (words.length === 0)
      continue;
    const cmd = commandBasename(words[0]);
    if (cmd === "sddx-run" || cmd === "sddx")
      continue;
    if (cmd === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (sub === undefined || !GIT_READ_SUBCOMMANDS.includes(sub)) {
        return {
          allow: false,
          reason: `git ${sub ?? "(none)"}: only git ${GIT_READ_SUBCOMMANDS.join("|")} are allowed pre-GREEN`
        };
      }
      continue;
    }
    if (!allowed.has(cmd)) {
      return { allow: false, reason: `"${cmd}" is not on the RED-phase Bash allow-list` };
    }
    if (EVAL_CAPABLE.has(cmd) && words.some((w) => EVAL_FLAGS.has(w))) {
      return {
        allow: false,
        reason: `${cmd} with an eval/print flag can write files from inline code`
      };
    }
  }
  return { allow: true };
}
function blockMessage(task, why) {
  return [
    `sddx TDD gate: blocked Bash command — task ${task.id} is in ${task.phase} (${why}).`,
    `Pre-GREEN, Bash may only run tests or read state: ${BASH_ALLOW_BASE.join(", ")}, git ${GIT_READ_SUBCOMMANDS.join("|")}, and the sddx CLI itself.`,
    "Write the failing test with Edit/Write under a test path and run the test runner so the failure is recorded (the gate lifts in GREEN).",
    "A legitimately needed read-only tool can be added via userConfig red_bash_allow."
  ].join(`
`);
}
function bashGate(input, env = process.env) {
  if (typeof input.command !== "string" || input.command.trim() === "")
    return { allow: true };
  if (checkBashCommand(input.command, []).allow)
    return { allow: true };
  const res = resolveTask(input.cwd ?? process.cwd());
  if (res.kind === "none")
    return { allow: true };
  const failure = resolutionFailureReason(res, "running commands");
  if (failure)
    return { allow: false, reason: failure };
  if (res.kind !== "task")
    return { allow: true };
  if (res.task.phase !== "PLAN" && res.task.phase !== "RED")
    return { allow: true };
  const extra = splitList(env.SDDX_RED_BASH_ALLOW ?? readConfig(res.root).red_bash_allow);
  const decision = checkBashCommand(input.command, extra);
  if (decision.allow)
    return decision;
  return { allow: false, reason: blockMessage(res.task, decision.reason) };
}

// src/lib/receipt.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync as existsSync6,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync4,
  readFileSync as readFileSync6,
  writeFileSync as writeFileSync4
} from "node:fs";
import { join as join6 } from "node:path";
var sha256 = (data) => createHash("sha256").update(data).digest("hex");
var receiptsDir = (cwd) => join6(cwd, ".sddx", "receipts");
var receiptPath = (cwd, taskId2) => join6(receiptsDir(cwd), `${taskId2}.json`);
function listReceipts(cwd) {
  const dir = receiptsDir(cwd);
  if (!existsSync6(dir))
    return [];
  return readdirSync4(dir).filter((f) => f.endsWith(".json")).map((f) => ({
    file: join6(dir, f),
    receipt: JSON.parse(readFileSync6(join6(dir, f), "utf8"))
  })).sort((a, b) => a.receipt.seq - b.receipt.seq);
}
function chainHead(cwd) {
  const receipts = listReceipts(cwd);
  const last = receipts.at(-1);
  if (!last)
    return { seq: 0, prevHash: "genesis" };
  return { seq: last.receipt.seq, prevHash: sha256(readFileSync6(last.file)) };
}
function writeReceipt(cwd, r) {
  const schemaErrors = validateReceipt(r);
  if (schemaErrors.length > 0) {
    throw new Error(`refusing to write invalid receipt: ${schemaErrors.join("; ")}`);
  }
  const path = receiptPath(cwd, r.task_id);
  if (existsSync6(path)) {
    throw new Error(`receipt for ${r.task_id} already exists — receipts are immutable`);
  }
  mkdirSync4(receiptsDir(cwd), { recursive: true });
  writeFileSync4(path, `${JSON.stringify(r, null, 2)}
`);
  chmodSync(path, 292);
  return path;
}
var HEX64 = /^[0-9a-f]{64}$/;
var HEX40 = /^[0-9a-f]{40}$/;
function validateReceipt(raw) {
  const errors = [];
  if (typeof raw !== "object" || raw === null)
    return ["receipt must be an object"];
  const r = raw;
  const need = (field, ok) => {
    if (!ok)
      errors.push(`${field}: missing or invalid`);
  };
  need("version", r.version === 1 || r.version === 2 || r.version === 3);
  const version = typeof r.version === "number" ? r.version : 0;
  if (version >= 2) {
    need("allow", Array.isArray(r.allow) && r.allow.every((p) => typeof p === "string"));
  } else {
    need("allow", r.allow === undefined);
  }
  if (version <= 2) {
    need("exit_code", typeof r.exit_code === "number");
    need("duration_ms", typeof r.duration_ms === "number" && r.duration_ms >= 0);
    need("stdout_sha256", typeof r.stdout_sha256 === "string" && HEX64.test(r.stdout_sha256));
    need("stderr_sha256", typeof r.stderr_sha256 === "string" && HEX64.test(r.stderr_sha256));
    need("runs", r.runs === undefined);
    need("env", r.env === undefined);
    need("signature", r.signature === undefined && r.signer === undefined);
  } else {
    need("exit_code", r.exit_code === undefined);
    need("duration_ms", r.duration_ms === undefined);
    need("stdout_sha256", r.stdout_sha256 === undefined);
    need("stderr_sha256", r.stderr_sha256 === undefined);
    const runs = r.runs;
    need("runs", Array.isArray(runs) && runs.length >= 1 && runs.every((run) => typeof run === "object" && run !== null && typeof run.exit_code === "number" && typeof run.duration_ms === "number" && run.duration_ms >= 0 && HEX64.test(String(run.stdout_sha256)) && HEX64.test(String(run.stderr_sha256))));
    const env = r.env;
    need("env", !!env && typeof env === "object" && typeof env.os === "string" && env.os !== "" && typeof env.arch === "string" && env.arch !== "" && (env.runtime === "bun" || env.runtime === "node") && typeof env.runtime_version === "string" && env.runtime_version !== "" && typeof env.dirty_tree === "boolean");
    need("signature", r.signature === undefined && r.signer === undefined || typeof r.signature === "string" && r.signature !== "" && typeof r.signer === "string" && r.signer !== "");
  }
  need("task_id", typeof r.task_id === "string" && r.task_id !== "");
  need("seq", typeof r.seq === "number" && Number.isInteger(r.seq) && r.seq >= 1);
  need("prev", r.prev === "genesis" || typeof r.prev === "string" && HEX64.test(r.prev));
  need("harness", typeof r.harness === "string" && r.harness !== "");
  need("model", r.model === null || typeof r.model === "string");
  need("plugin_version", typeof r.plugin_version === "string");
  const o = r.oracle;
  need("oracle", !!o && typeof o === "object" && typeof o.run === "string" && typeof o.expect === "string");
  need("base_sha", typeof r.base_sha === "string" && HEX40.test(r.base_sha));
  need("tree_sha", typeof r.tree_sha === "string" && HEX40.test(r.tree_sha));
  need("verdict", r.verdict === "pass");
  need("verified_at", typeof r.verified_at === "string" && !Number.isNaN(Date.parse(r.verified_at)));
  return errors;
}
function readReceiptFrom(dir, id) {
  try {
    return JSON.parse(readFileSync6(receiptPath(dir, id), "utf8"));
  } catch {
    return null;
  }
}
function readReceiptFromBranch(cwd, id) {
  const r = spawnSync4("git", ["show", `sddx/${id}:.sddx/receipts/${id}.json`], {
    cwd,
    encoding: "utf8"
  });
  if (r.status !== 0)
    return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}
function resolveReceipt(cwd, id) {
  return readReceiptFrom(join6(cwd, ".sddx-worktrees", id), id) ?? readReceiptFrom(cwd, id) ?? readReceiptFromBranch(cwd, id);
}
function verifyChain(cwd) {
  const errors = [];
  const receipts = listReceipts(cwd);
  const seqByHash = new Map;
  for (const { file, receipt } of receipts) {
    seqByHash.set(sha256(readFileSync6(file)), receipt.seq);
  }
  for (const { file, receipt } of receipts) {
    for (const e of validateReceipt(receipt))
      errors.push(`${file}: ${e}`);
    if (receipt.prev === "genesis") {
      if (receipt.seq !== 1) {
        errors.push(`${file}: genesis-linked receipt must have seq 1, got ${receipt.seq}`);
      }
      continue;
    }
    const parentSeq = seqByHash.get(receipt.prev);
    if (parentSeq === undefined) {
      errors.push(`${file}: prev hash matches no receipt — chain broken (tampered or deleted)`);
    } else if (parentSeq >= receipt.seq) {
      errors.push(`${file}: seq ${receipt.seq} must exceed parent seq ${parentSeq}`);
    }
  }
  return errors;
}

// src/lib/recorder.ts
var TEST_RUNNER_PREFIXES = [
  "bun test",
  "npm test",
  "pnpm test",
  "yarn test",
  "npx vitest",
  "npx jest",
  "pytest",
  "go test",
  "cargo test"
];
function matchTestRunner(command) {
  const trimmed = command.trim();
  for (const prefix of TEST_RUNNER_PREFIXES) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `))
      return prefix;
  }
  return null;
}
function failureFingerprint(exitCode, output, command = "") {
  const tail = output.split(`
`).slice(-20).join(`
`).replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
  return sha256(`${exitCode}
${command.trim()}
${tail}`);
}
function recordTestRun(cwd, command, exitCode, output = "") {
  if (matchTestRunner(command) === null || exitCode === undefined) {
    return { matched: false, transitioned: null };
  }
  const res = resolveTask(cwd);
  if (res.kind !== "task")
    return { matched: true, transitioned: null };
  const task = res.task;
  const at = new Date().toISOString();
  if (exitCode !== 0) {
    const fp = failureFingerprint(exitCode, output, command);
    task.stuck = task.stuck?.fingerprint === fp ? { fingerprint: fp, count: task.stuck.count + 1, since: task.stuck.since } : { fingerprint: fp, count: 1, since: at };
  } else if (task.stuck) {
    task.stuck = undefined;
  }
  let to = null;
  if (task.phase === "PLAN" && exitCode !== 0)
    to = "RED";
  if ((task.phase === "RED" || task.phase === "REFACTOR") && exitCode === 0)
    to = "GREEN";
  if (to) {
    transition(task, to, { testExit: exitCode, source: "hook" });
  } else {
    task.evidence.last_test = { test_exit: exitCode, at, source: "hook" };
  }
  let stuck;
  if (task.stuck) {
    const threshold = stuckThreshold(res.root);
    if (task.stuck.count >= threshold)
      stuck = { count: task.stuck.count, threshold };
  }
  writeTask(res.root, task);
  return { matched: true, transitioned: to, taskId: task.id, stuck };
}

// src/lib/stopgate.ts
import { existsSync as existsSync7 } from "node:fs";
import { join as join7 } from "node:path";
var NEXT_STEP = {
  PLAN: "write a failing test and run it to enter RED",
  RED: "run sddx red-check <id>, then make the failing test pass (run the test runner to enter GREEN)",
  GREEN: "refactor if needed, then: sddx task phase <id> VERIFY && sddx verify <id>",
  REFACTOR: "re-run tests to return to GREEN, then verify",
  VERIFY: "run: sddx verify <id>",
  DONE: "",
  ABANDONED: ""
};
function stopGate(event) {
  if (event.stop_hook_active)
    return { block: false };
  const res = resolveTask(event.cwd ?? process.cwd());
  if (res.kind === "none")
    return { block: false };
  if (res.kind === "ambiguous") {
    return {
      block: true,
      reason: `sddx: tasks ${res.ids.join(" and ")} are both unfinished in this workspace — finish or abandon them before stopping.`
    };
  }
  if (res.kind === "corrupt") {
    return {
      block: true,
      reason: `sddx: task state at ${res.path} is unreadable — completion cannot be proven. Fix the state file before stopping.`
    };
  }
  const { task } = res;
  if (isTerminal(task.phase)) {
    const receipt = join7(res.root, ".sddx", "receipts", `${task.id}.json`);
    if (task.phase === "DONE" && !existsSync7(receipt)) {
      return {
        block: true,
        reason: `sddx: task ${task.id} is DONE but .sddx/receipts/${task.id}.json is missing — completion is unproven. Restore the receipt or abandon the task.`
      };
    }
    return { block: false };
  }
  if (task.stuck && task.stuck.count >= stuckThreshold(res.root)) {
    return {
      block: false,
      note: `sddx: task ${task.id} is stuck — ${task.stuck.count} identical failures; escalating to the human is the correct next step.`
    };
  }
  const step = NEXT_STEP[task.phase].replaceAll("<id>", task.id);
  return {
    block: true,
    reason: `sddx: task ${task.id} is in ${task.phase} without a verified receipt — ${step}.`
  };
}

// src/tdd-gate.ts
import { isAbsolute, relative as relative2, resolve } from "node:path";
function loadGateConfig(root, env = process.env) {
  const fileConfig = readConfig(root);
  return {
    testGlobs: env.SDDX_TEST_GLOBS ?? fileConfig.test_globs,
    exemptGlobs: env.SDDX_EXEMPT_GLOBS ?? fileConfig.exempt_globs
  };
}
function blockMessage2(task, relPath, config) {
  const testGlobs = [
    ...BUILTIN_TEST_GLOBS,
    ...(config.testGlobs ?? "").split(/\s+/).filter((g) => g !== "")
  ];
  return [
    `sddx TDD gate: blocked write to ${relPath} — task ${task.id} is in ${task.phase} (rule: implementation path).`,
    `Before GREEN, only test files may change. Do this instead:`,
    `  1. Write a failing test for "${task.task}" under a test path (${testGlobs.slice(0, 4).join(", ")}, …).`,
    "  2. Run the test runner so the failure is recorded (the gate lifts in GREEN).",
    `  3. Only for files that genuinely cannot be test-driven: sddx task allow ${task.id} ${relPath} — the exemption is audited in the receipt.`
  ].join(`
`);
}
function tddGate(input, env = process.env) {
  const anchor = input.filePath ? isAbsolute(input.filePath) ? input.filePath : resolve(input.cwd ?? process.cwd(), input.filePath) : input.cwd ?? process.cwd();
  const res = resolveTask(anchor);
  if (res.kind === "none")
    return { allow: true };
  const failure = resolutionFailureReason(res, "writing");
  if (failure)
    return { allow: false, reason: failure };
  if (res.kind !== "task")
    return { allow: true };
  if (res.task.phase !== "PLAN" && res.task.phase !== "RED")
    return { allow: true };
  if (!input.filePath)
    return { allow: true };
  const relPath = relative2(res.root, anchor);
  const config = input.config ?? loadGateConfig(res.root, env);
  const cls = classify(relPath, res.task.allow, config);
  if (cls.rule !== "implementation")
    return { allow: true };
  return { allow: false, reason: blockMessage2(res.task, relPath, config) };
}

// src/hooks.ts
function readEvent() {
  try {
    const raw = readFileSync7(0, "utf8");
    const parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
var emit = (output) => {
  console.log(JSON.stringify(output));
};
function cmdTddGate(event) {
  const decision = tddGate({
    filePath: event.tool_input?.file_path ?? event.tool_input?.notebook_path,
    cwd: event.cwd
  });
  if (decision.allow) {
    emit(decision.diagnostic ? { systemMessage: decision.diagnostic } : {});
    return;
  }
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason
    }
  });
}
function cmdBashGate(event) {
  const decision = bashGate({ command: event.tool_input?.command, cwd: event.cwd });
  if (decision.allow) {
    emit({});
    return;
  }
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason
    }
  });
}
function exitCodeOf(response) {
  for (const key of ["exit_code", "exitCode", "code"]) {
    const v = response?.[key];
    if (typeof v === "number")
      return v;
  }
  return;
}
function outputOf(response) {
  let out = "";
  for (const key of ["stdout", "stderr", "output"]) {
    const v = response?.[key];
    if (typeof v === "string")
      out += v;
  }
  return out;
}
function cmdRecordTest(event) {
  const command = event.tool_input?.command;
  if (typeof command !== "string") {
    emit({});
    return;
  }
  const res = recordTestRun(event.cwd ?? process.cwd(), command, exitCodeOf(event.tool_response), outputOf(event.tool_response));
  const parts = [];
  if (res.transitioned)
    parts.push(`sddx: task ${res.taskId} → ${res.transitioned} (observed test run)`);
  if (res.stuck)
    parts.push(`sddx: task ${res.taskId} has failed identically ${res.stuck.count}× (threshold ${res.stuck.threshold}) — stuck; stop and escalate to the human instead of iterating.`);
  emit(parts.length > 0 ? { systemMessage: parts.join(`
`) } : {});
}
function cmdStopGate(event) {
  const decision = stopGate({ cwd: event.cwd, stop_hook_active: event.stop_hook_active });
  emit(decision.block ? { decision: "block", reason: decision.reason } : decision.note ? { systemMessage: decision.note } : {});
}
function boardEnabled(cwd, env = process.env) {
  if (env.SDDX_BOARD_ENABLED !== undefined) {
    return !["false", "0"].includes(env.SDDX_BOARD_ENABLED);
  }
  const cfg = readConfig(cwd).board_enabled;
  return typeof cfg === "boolean" ? cfg : true;
}
function cmdSessionStart(event) {
  const cwd = event.cwd ?? process.cwd();
  const lines = [];
  if (existsSync8(join8(cwd, ".sddx"))) {
    try {
      const res = sweep(cwd);
      if (res.removed.length > 0)
        lines.push(`sddx: swept ${res.removed.length} orphan worktree(s)`);
    } catch {}
    if (boardEnabled(cwd)) {
      try {
        writeBoard(cwd);
      } catch (e) {
        lines.push(`sddx: board refresh failed: ${e.message}`);
      }
    }
    const tasksDir = join8(cwd, ".sddx", "tasks");
    if (existsSync8(tasksDir)) {
      for (const file of readdirSync5(tasksDir).filter((f) => f.endsWith(".json"))) {
        try {
          const t = JSON.parse(readFileSync7(join8(tasksDir, file), "utf8"));
          if (!isTerminal(t.phase))
            lines.push(`sddx task ${t.id}: phase ${t.phase} — ${t.task}`);
        } catch {
          lines.push(`sddx: task file ${file} is unreadable`);
        }
      }
    }
  }
  if (lines.length === 0) {
    emit({});
    return;
  }
  emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(`
`) }
  });
}
function main() {
  const sub = process.argv[2];
  const event = readEvent();
  try {
    if (sub === "tdd-gate")
      cmdTddGate(event);
    else if (sub === "bash-gate")
      cmdBashGate(event);
    else if (sub === "record-test")
      cmdRecordTest(event);
    else if (sub === "stop-gate")
      cmdStopGate(event);
    else if (sub === "session-start")
      cmdSessionStart(event);
    else
      emit({ systemMessage: `sddx hooks: unknown subcommand ${sub ?? "(none)"}` });
  } catch (e) {
    emit({ systemMessage: `sddx hook error (${sub}): ${e.message}` });
  }
  process.exit(0);
}
main();
