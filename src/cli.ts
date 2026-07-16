import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
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
  readTask,
  sddxDir,
  taskId,
  transition,
  writeTask,
  type Phase,
} from "./lib/task";
import { verifyTask } from "./lib/verify";

const USAGE = `usage:
  sddx task create --spec <path> [--no-branch]
  sddx task phase <id> <PHASE> [--test-exit <n>]
  sddx task show <id>
  sddx verify <id> [--model <m>] [--harness <h>]
  sddx cleanup <id>`;

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

function cmdTaskCreate(cwd: string, args: string[]): void {
  const specArg = flag(args, "--spec");
  if (!specArg) fail(USAGE, 2);
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
  const useBranch = !args.includes("--no-branch");
  const base = headSha(cwd);
  if (useBranch) createBranch(cwd, `sddx/${id}`);

  mkdirSync(join(sddxDir(cwd), "specs"), { recursive: true });
  const specPath = join(".sddx", "specs", `${id}.yaml`);
  copyFileSync(join(cwd, specArg), join(cwd, specPath));

  createTask(cwd, spec, specPath, {
    mode: useBranch ? "branch" : "none",
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

function main(argv: string[]): void {
  const cwd = process.cwd();
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "task" && rest[0] === "create") return cmdTaskCreate(cwd, rest.slice(1));
    if (cmd === "task" && rest[0] === "phase") return cmdTaskPhase(cwd, rest.slice(1));
    if (cmd === "task" && rest[0] === "show") {
      if (!rest[1]) fail(USAGE, 2);
      console.log(JSON.stringify(readTask(cwd, rest[1]!), null, 2));
      return;
    }
    if (cmd === "verify") return cmdVerify(cwd, rest);
    if (cmd === "cleanup") return cmdCleanup(cwd, rest);
    fail(USAGE, 2);
  } catch (e) {
    fail((e as Error).message);
  }
}

main(process.argv.slice(2));
