import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = new URL("..", import.meta.url).pathname;

export const CLI = join(repoRoot, "src/cli.ts");

/** This process's environment as a person's own shell would pass it on: never
 * marked as a Codex agent's tool call, even when the tests run inside Codex. */
export function userEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CODEX_TOOL_CALL_ID;
  return { ...env, ...extra };
}

/** Runs the CLI from source, as the user would. */
export function sddx(cwd: string, ...args: string[]) {
  return spawnSync("bun", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: userEnv({ NO_COLOR: "1" }),
  });
}

export interface SpecTaskInput {
  id: string;
  title?: string;
  /** Oracle command. Defaults to `test -f <id>.done`, which fails on the base and
   * passes once `completeTask` creates the file, so the boundary proof holds. */
  run?: string;
  type?: string;
  expect?: string;
  scope?: string[] | null;
  dependsOn?: string[];
  /** Raw YAML lines appended to the task's sddx block. */
  extra?: string;
  /** Raw YAML lines appended inside `oracle:`, e.g. "runs: 3" (indentation is added). */
  oracleExtra?: string;
}

export interface GoalSpecInput {
  title?: string;
  tasks: SpecTaskInput[];
  openDecisions?: string[];
  assumptions?: string[];
}

export const doneFile = (id: string): string => `${id}.done`;

/** Markdown for a goal spec with the required Design skeleton. */
export function goalSpec(input: GoalSpecInput): string {
  const lines = [
    `# ${input.title ?? "Test goal"}`,
    "",
    "## Design",
    "",
    "### Goal",
    "Exercise sddx.",
    "",
    "### Acceptance",
    "- every task's oracle passes",
    "",
    "### Non-goals",
    "",
    "### Assumptions",
    ...(input.assumptions ?? []).map((a) => `- ${a}`),
    "",
    "### Open decisions",
    ...(input.openDecisions ?? []).map((d) => `- ${d}`),
    "",
    "## Tasks",
    "",
  ];
  for (const t of input.tasks) {
    const scope = t.scope === null ? [] : (t.scope ?? [doneFile(t.id)]);
    lines.push(`### ${t.id} ${t.title ?? `Task ${t.id}`}`, "", "```sddx", "oracle:");
    lines.push(`  type: ${t.type ?? "command"}`);
    if ((t.type ?? "command") !== "manual") {
      lines.push(`  run: ${JSON.stringify(t.run ?? `test -f ${doneFile(t.id)}`)}`);
      lines.push(`  expect: ${t.expect ?? "exit 0"}`);
    }
    for (const l of (t.oracleExtra ?? "").split("\n").filter((x) => x.trim() !== "")) {
      lines.push(`  ${l}`);
    }
    if (scope.length > 0) lines.push(`scope: [${scope.map((g) => JSON.stringify(g)).join(", ")}]`);
    if (t.dependsOn && t.dependsOn.length > 0)
      lines.push(`depends_on: [${t.dependsOn.join(", ")}]`);
    if (t.extra) lines.push(t.extra);
    lines.push("```", "");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes `.sddx/specs/<name>.md` and returns its repository-relative path. */
export function writeSpec(cwd: string, name: string, text: string): string {
  const rel = join(".sddx", "specs", `${name}.md`);
  mkdirSync(join(cwd, ".sddx", "specs"), { recursive: true });
  writeFileSync(join(cwd, rel), text);
  commitSpec(cwd, rel);
  return rel;
}

/** Commits a spec as the brainstorm step would: plan commands refuse an uncommitted one. */
export function commitSpec(cwd: string, rel: string): void {
  spawnSync("git", ["add", "--", rel], { cwd });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", rel], { cwd });
  if (staged.status === 0) return;
  const r = spawnSync("git", ["commit", "-q", "-m", `plan: ${rel}`, "--", rel], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`commitSpec ${rel}: ${r.stderr}`);
}

export interface CreatedRun {
  goalId: string;
  specPath: string;
  runBranch: string;
  taskIds: string[];
}

/** Writes a spec, approves it unless told not to, and starts the plan. */
export function createRun(
  cwd: string,
  input: GoalSpecInput & { name?: string; approve?: boolean },
): CreatedRun {
  const name = input.name ?? "2026-01-01-test-goal";
  const specPath = writeSpec(cwd, name, goalSpec(input));
  if (input.approve !== false) {
    const a = sddx(cwd, "plan", "approve", specPath);
    if (a.status !== 0) throw new Error(`plan approve failed: ${a.stderr || a.stdout}`);
  }
  const s = sddx(cwd, "plan", "start", specPath, "--output", "json");
  if (s.status !== 0) throw new Error(`plan start failed: ${s.stderr || s.stdout}`);
  const data = JSON.parse(s.stdout).data as {
    goalId: string;
    runBranch: string;
    taskIds: string[];
  };
  return { goalId: data.goalId, specPath, runBranch: data.runBranch, taskIds: data.taskIds };
}

/** `sddx task start <id>`, returning the worktree path. */
export function startTask(cwd: string, id: string): string {
  const r = sddx(cwd, "task", "start", id, "--output", "json");
  if (r.status !== 0) throw new Error(`task start ${id} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout).data.path as string;
}

/** Creates the file the default oracle checks, then verifies and passes review. */
export function completeTask(cwd: string, id: string): { worktree: string; receiptPath: string } {
  const wt = startTask(cwd, id);
  writeFileSync(join(wt, doneFile(id)), "done\n");
  const v = sddx(cwd, "verify", id);
  if (v.status !== 0) throw new Error(`verify ${id} failed: ${v.stderr || v.stdout}`);
  const r = sddx(
    cwd,
    "review",
    "record",
    id,
    "--verdict",
    "pass",
    "--reviewer",
    "test",
    "--output",
    "json",
  );
  if (r.status !== 0) throw new Error(`review ${id} failed: ${r.stderr || r.stdout}`);
  return { worktree: wt, receiptPath: JSON.parse(r.stdout).data.receiptPath as string };
}

/** Where a task's state file lives: its worktree once started, else the main checkout. */
export function taskStatePath(root: string, id: string): string {
  const inWorktree = join(root, ".sddx-worktrees", id, ".sddx", "tasks", `${id}.json`);
  return existsSync(inWorktree) ? inWorktree : join(root, ".sddx", "tasks", `${id}.json`);
}

export function readTaskState(
  root: string,
  id: string,
): Record<string, unknown> & { phase: string } {
  return JSON.parse(readFileSync(taskStatePath(root, id), "utf8"));
}

export async function runsCleanly(cmd: string[], env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await new Response(proc.stderr).text()).toBe("");
}

/** Goal ids visible to sddx: goal refs plus legacy loose records. */
export function goalIds(cwd: string): string[] {
  const ids = new Set<string>();
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  for (const r of (refs.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (r.startsWith("refs/sddx/goals/")) ids.add(r.slice("refs/sddx/goals/".length));
  }
  return [...ids].sort();
}

/** A goal record, read from wherever it lives. */
export function readGoalAnywhere(cwd: string, id: string): Record<string, unknown> {
  const r = spawnSync("git", ["cat-file", "-p", `refs/sddx/goals/${id}`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status === 0) return JSON.parse(r.stdout);
  const loose = join(cwd, ".sddx", "goals", `${id}.json`);
  if (existsSync(loose)) return JSON.parse(readFileSync(loose, "utf8"));
  throw new Error(`no goal ${id} in ${cwd}: ${r.stderr}`);
}

/** Rewrites a goal record wherever it lives — for tests that tamper with it. */
export function mutateGoal(cwd: string, mutate: (g: Record<string, unknown>) => void): void {
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  const ids = (refs.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((r) => r.startsWith("refs/sddx/goals/"))
    .map((r) => r.slice("refs/sddx/goals/".length));
  for (const id of ids) {
    const g = readGoalAnywhere(cwd, id);
    mutate(g);
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd,
      input: `${JSON.stringify(g, null, 2)}\n`,
      encoding: "utf8",
    });
    spawnSync("git", ["update-ref", `refs/sddx/goals/${id}`, (blob.stdout ?? "").trim()], { cwd });
  }
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const p = join(dir, f);
      const g = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      mutate(g);
      writeFileSync(p, `${JSON.stringify(g, null, 2)}\n`);
    }
  }
}
