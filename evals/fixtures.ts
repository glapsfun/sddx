// Fixture repositories, built fresh for every session. The base is a tiny Bun
// project with one test, so it needs no network. Fixtures past the design step
// drive the checkout's own CLI as the user would: the approval is the user's,
// typed outside the session, never the agent's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FixtureInfo, Mode } from "./types";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface FixtureContext {
  /** The checkout's CLI, run as the user. */
  sddx: (cwd: string, ...args: string[]) => RunResult;
  mode: Mode;
  /** `tests/fixtures/v5-repo.tar.gz` of the checkout under test. */
  v5Archive: string;
}

export type FixtureBuilder = (dir: string, ctx: FixtureContext) => FixtureInfo;

export const SPEC = ".sddx/specs/2026-01-01-farewell.md";
export const GOAL = "2026-01-01-farewell";
export const TASK = "farewell-1";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}

function cli(ctx: FixtureContext, dir: string, ...args: string[]): string {
  const r = ctx.sddx(dir, ...args);
  if (r.status !== 0) throw new Error(`sddx ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const DESIGN = `# Farewell

## Design

### Goal
Add \`farewell(name)\` next to \`greet\`, returning \`Goodbye, <name>!\`.

### Acceptance
- \`farewell("Ada")\` returns \`Goodbye, Ada!\`
- \`bun test\` passes

### Non-goals
- Changing \`greet\`

### Assumptions
- \`farewell\` lives in its own module, \`src/farewell.ts\`

### Open decisions
`;

const TASKS = `
## Tasks

### ${TASK} Add farewell

\`\`\`sddx
oracle:
  type: command
  run: "bun test src/farewell.test.ts"
  expect: exit 0
scope: ["src/farewell.ts", "src/farewell.test.ts"]
\`\`\`
`;

const SOLUTION = {
  "src/farewell.ts":
    "export function farewell(name: string): string {\n  return `Goodbye, $" + "{name}!`;\n}\n",
  "src/farewell.test.ts":
    'import { expect, test } from "bun:test";\nimport { farewell } from "./farewell";\n\ntest("farewell", () => {\n  expect(farewell("Ada")).toBe("Goodbye, Ada!");\n});\n',
};

/** A git repository holding the greeter project, with its own identity. */
function plain(dir: string): FixtureInfo {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, {
    "README.md": "# Greeter\n\nHelo from the greeter fixture.\n",
    "package.json": `${JSON.stringify({ name: "greeter", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
    "src/greet.ts":
      "export function greet(name: string): string {\n  return `Hello, $" + "{name}!`;\n}\n",
    "src/greet.test.ts":
      'import { expect, test } from "bun:test";\nimport { greet } from "./greet";\n\ntest("greet", () => {\n  expect(greet("Ada")).toBe("Hello, Ada!");\n});\n',
  });
  commitAll(dir, "init");
  return {};
}

function optedIn(dir: string, ctx: FixtureContext, profile?: string): FixtureInfo {
  plain(dir);
  const cfg = {
    schema_version: "2.0",
    interaction_mode: ctx.mode,
    ...(profile ? { profile } : {}),
  };
  write(dir, { ".sddx/config.json": `${JSON.stringify(cfg, null, 2)}\n` });
  commitAll(dir, "opt in to sddx");
  return {};
}

function withSpec(dir: string, ctx: FixtureContext, tasks: boolean, profile?: string): FixtureInfo {
  optedIn(dir, ctx, profile);
  write(dir, { [SPEC]: DESIGN + (tasks ? TASKS : "") });
  commitAll(dir, `plan: ${SPEC}`);
  return { spec: SPEC, goal: GOAL };
}

function started(dir: string, ctx: FixtureContext, profile?: string): FixtureInfo {
  withSpec(dir, ctx, true, profile);
  if (ctx.mode === "human") cli(ctx, dir, "plan", "approve", SPEC);
  cli(ctx, dir, "plan", "start", SPEC);
  return { spec: SPEC, goal: GOAL, task: TASK };
}

function inReview(dir: string, ctx: FixtureContext): FixtureInfo {
  const info = started(dir, ctx);
  const out = JSON.parse(cli(ctx, dir, "task", "start", TASK, "--output", "json"));
  write(resolve(dir, out.data.path as string), SOLUTION);
  cli(ctx, dir, "verify", TASK);
  return info;
}

function v5(dir: string, ctx: FixtureContext): FixtureInfo {
  const r = spawnSync("tar", ["-xzf", ctx.v5Archive, "-C", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar -xzf ${ctx.v5Archive} failed: ${r.stderr}`);
  const trees = join(dir, ".sddx-worktrees");
  if (existsSync(trees)) {
    const paths = readdirSync(trees).map((n) => join(trees, n));
    if (paths.length > 0) git(dir, "worktree", "repair", ...paths);
  }
  return {};
}

export const FIXTURES: Record<string, FixtureBuilder> = {
  plain: (dir) => plain(dir),
  "opted-in": (dir, ctx) => optedIn(dir, ctx),
  "design-only": (dir, ctx) => withSpec(dir, ctx, false),
  "approval-pending": (dir, ctx) => withSpec(dir, ctx, true),
  "planned-goal": (dir, ctx) => started(dir, ctx),
  "strict-goal": (dir, ctx) => started(dir, ctx, "strict"),
  "in-review": inReview,
  v5,
};
