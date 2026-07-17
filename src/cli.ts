import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchExists,
  createBranch,
  currentBranch,
  deleteBranch,
  headSha,
  isMerged,
} from "./lib/git";
import { parseSpec } from "./lib/spec";
import {
  createTask,
  type Phase,
  readTask,
  sddxDir,
  taskId,
  transition,
  writeTask,
} from "./lib/task";
import { verifyTask } from "./lib/verify";
import {
  createWorktree,
  hasSubmodules,
  isDirty,
  removeWorktree,
  resolveBaseRef,
  sweep,
  worktreeAvailable,
  worktreesDir,
} from "./lib/worktree";

const USAGE = `usage:
  sddx task create --spec <path> [--workspace auto|worktree|branch|none] [--no-branch]
  sddx task phase <id> <PHASE> [--test-exit <n>]
  sddx task show <id>
  sddx verify <id> [--model <m>] [--harness <h>]
  sddx cleanup <id>
  sddx sweep`;

function fail(message: string, code: 1 | 2 = 1): never {
  console.error(message);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} requires a value`, 2);
  return v;
}

function pluginVersion(): string {
  try {
    const manifest = new URL("../.claude-plugin/plugin.json", import.meta.url);
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const WORKSPACE_MODES = ["auto", "worktree", "branch", "none"] as const;
type WorkspaceFlag = (typeof WORKSPACE_MODES)[number];

function pickWorkspace(cwd: string, requested: WorkspaceFlag): "worktree" | "branch" | "none" {
  if (requested !== "auto") return requested;
  if (!worktreeAvailable(cwd)) {
    console.log("git worktree unavailable → branch mode");
    return "branch";
  }
  const base = resolveBaseRef(cwd);
  if (hasSubmodules(cwd, base.sha)) {
    console.log("submodules detected → branch mode");
    return "branch";
  }
  return "worktree";
}

function cmdTaskCreate(cwd: string, args: string[]): void {
  const specArg = flag(args, "--spec");
  if (!specArg) fail(USAGE, 2);
  const requested = (flag(args, "--workspace") ??
    (args.includes("--no-branch") ? "none" : "auto")) as WorkspaceFlag;
  if (!WORKSPACE_MODES.includes(requested)) fail(USAGE, 2);
  let yamlText: string;
  try {
    yamlText = readFileSync(join(cwd, specArg), "utf8");
  } catch {
    fail(`cannot read spec file: ${specArg}`);
  }
  const { spec, errors } = parseSpec(yamlText);
  if (!spec) {
    for (const e of errors) console.error(`spec error: ${e}`);
    process.exit(1);
  }
  const id = taskId(spec.task);
  const mode = pickWorkspace(cwd, requested);

  if (mode === "worktree") {
    const base = resolveBaseRef(cwd);
    if (base.source === "HEAD") console.log("no origin remote — forking from local HEAD");
    const wtPath = createWorktree(cwd, id, base.sha);
    const relPath = join(".sddx-worktrees", id);
    mkdirSync(join(sddxDir(wtPath), "specs"), { recursive: true });
    const specPath = join(".sddx", "specs", `${id}.yaml`);
    copyFileSync(join(cwd, specArg), join(wtPath, specPath));
    createTask(wtPath, spec, specPath, {
      mode: "worktree",
      branch: `sddx/${id}`,
      base_sha: base.sha,
      path: relPath,
    });
    console.log(`created ${id} phase=PLAN worktree=${relPath} branch=sddx/${id} base=${base.sha}`);
    return;
  }

  const useBranch = mode === "branch";
  const base = headSha(cwd);
  if (useBranch) createBranch(cwd, `sddx/${id}`);

  mkdirSync(join(sddxDir(cwd), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(join(cwd, specArg), join(cwd, specPath));

  createTask(cwd, spec, specPath, {
    mode,
    branch: useBranch ? `sddx/${id}` : null,
    base_sha: base,
  });
  console.log(`created ${id} phase=PLAN branch=${useBranch ? `sddx/${id}` : "none"}`);
}

function cmdTaskPhase(cwd: string, args: string[]): void {
  const [id, phase] = args;
  if (!id || !phase) fail(USAGE, 2);
  const testExitRaw = flag(args, "--test-exit");
  const task = readTask(cwd, id);
  transition(task, phase as Phase, {
    testExit: testExitRaw === undefined ? undefined : Number(testExitRaw),
  });
  writeTask(cwd, task);
  console.log(`${id} phase=${task.phase}`);
}

function cmdVerify(cwd: string, args: string[]): void {
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const res = verifyTask(cwd, id, {
    model: flag(args, "--model") ?? null,
    harness: flag(args, "--harness"),
    pluginVersion: pluginVersion(),
  });
  if (res.verdict === "pass") {
    console.log(
      `verdict=pass receipt=${res.receiptPath} commit=${res.commitSha} duration_ms=${res.durationMs}`,
    );
    return;
  }
  fail(
    `verdict=fail oracle_exit=${res.exitCode} duration_ms=${res.durationMs} iterations=${readTask(cwd, id).iterations}`,
  );
}

function cmdCleanup(cwd: string, args: string[]): void {
  const [id] = args;
  if (!id) fail(USAGE, 2);
  const branch = `sddx/${id}`;
  const wtPath = join(worktreesDir(cwd), id);
  if (existsSync(wtPath)) {
    if (isDirty(wtPath)) {
      fail(`refusing: worktree ${join(".sddx-worktrees", id)} has uncommitted changes`);
    }
    removeWorktree(cwd, wtPath);
    console.log(`removed worktree ${join(".sddx-worktrees", id)}`);
  }
  if (!branchExists(cwd, branch)) {
    console.log(`no branch ${branch} — nothing to clean up`);
    return;
  }
  if (currentBranch(cwd) === branch) {
    fail(`refusing: ${branch} is checked out — switch branches first`);
  }
  if (!isMerged(cwd, branch)) {
    fail(`refusing: ${branch} is not merged into HEAD`);
  }
  deleteBranch(cwd, branch);
  console.log(`deleted merged branch ${branch}`);
}

function cmdSweep(cwd: string): void {
  const res = sweep(cwd);
  if (res.locked) {
    console.log("sweep: another sweep holds the lock — skipped");
    return;
  }
  for (const path of res.removed) console.log(`swept ${path}`);
  for (const s of res.skipped) console.log(`skipped ${s.path} (${s.reason})`);
  console.log(`sweep: ${res.removed.length} removed, ${res.skipped.length} skipped`);
}

function main(argv: string[]): void {
  const cwd = process.cwd();
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "task" && rest[0] === "create") {
      cmdTaskCreate(cwd, rest.slice(1));
      return;
    }
    if (cmd === "task" && rest[0] === "phase") {
      cmdTaskPhase(cwd, rest.slice(1));
      return;
    }
    if (cmd === "task" && rest[0] === "show") {
      if (!rest[1]) fail(USAGE, 2);
      console.log(JSON.stringify(readTask(cwd, rest[1]), null, 2));
      return;
    }
    if (cmd === "verify") {
      cmdVerify(cwd, rest);
      return;
    }
    if (cmd === "cleanup") {
      cmdCleanup(cwd, rest);
      return;
    }
    if (cmd === "sweep") {
      cmdSweep(cwd);
      return;
    }
    fail(USAGE, 2);
  } catch (e) {
    fail((e as Error).message);
  }
}

main(process.argv.slice(2));
