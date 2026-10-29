// Builds tests/fixtures/v5-repo.tar.gz: a repository driven through sddx 5.0.0
// exactly as a user would, for `sddx migrate` tests. It runs the 5.0.0 bundle
// and templates taken from the `v5.0.0` tag, so it stays reproducible after the
// v5 code is gone from the working tree.
//
// The repository holds: committed `sddx init --adapter claude` output, a user
// hook in `.claude/settings.json`, a goal with one DONE task (its v4 receipt
// merged into main) and one task left in RED inside its own worktree.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_PATH = join("tests", "fixtures", "v5-repo.tar.gz");

function run(cwd: string, cmd: string, args: string[], expectStatus = 0): string {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (r.status !== expectStatus) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function extractV5Bundle(repoRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sddx-v5-bundle-"));
  const archive = spawnSync(
    "git",
    ["archive", "--format=tar", "v5.0.0", "dist/cli.mjs", "templates", "package.json"],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  if (archive.status !== 0) throw new Error(`git archive v5.0.0 failed: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar -x failed: ${untar.stderr}`);
  return join(dir, "dist", "cli.mjs");
}

const SPEC = (task: string, file: string, test: string): string =>
  [
    `task: ${task}`,
    "context: []",
    "success_criteria:",
    `  - "bun test ${test} exits 0"`,
    "scope:",
    `  - "${file}"`,
    `  - "${test}"`,
    "oracle:",
    "  type: command",
    `  run: "bun test ${test}"`,
    "  expect: exit 0",
    "stop_rules:",
    "  - max_iterations: 5",
    "out_of_scope: []",
    "",
  ].join("\n");

export function buildV5Repo(repoRoot: string): string {
  const cli = extractV5Bundle(repoRoot);
  const dir = mkdtempSync(join(tmpdir(), "sddx-v5-repo-"));
  const git = (...args: string[]) => run(dir, "git", args);
  const sddx = (cwd: string, ...args: string[]) => run(cwd, "bun", [cli, ...args]);

  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "v5 fixture\n");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  git("add", "-A");
  git("commit", "-qm", "init");

  sddx(dir, "init", "--yes", "--runtime", "global", "--adapter", "claude");
  git("add", "-A");
  git("commit", "-qm", "sddx init");

  const drafts = join(dir, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  writeFileSync(
    join(drafts, "health.yaml"),
    SPEC("health returns ok", "health.ts", "tests/health.test.ts"),
  );
  writeFileSync(
    join(drafts, "ping.yaml"),
    SPEC("ping returns pong", "ping.ts", "tests/ping.test.ts"),
  );
  const graph = join(".sddx", "drafts", "2026-10-26-fixture-graph.yaml");
  writeFileSync(
    join(dir, graph),
    [
      'schema_version: "1.0"',
      "interaction_mode: human",
      "goal: fixture goal",
      "tasks:",
      "  - alias: health",
      "    spec: health.yaml",
      "  - alias: ping",
      "    spec: ping.yaml",
      "",
    ].join("\n"),
  );
  git("add", "-A");
  git("commit", "-qm", "plan drafts");

  sddx(dir, "graph", "approve", "--graph", graph);
  const created = JSON.parse(sddx(dir, "graph", "create", "--graph", graph, "--output", "json"))
    .data as { taskIds: string[]; goalId: string };
  git("add", "-A");
  git("commit", "-qm", "approval token");
  const [healthId, pingId] = created.taskIds as [string, string];

  const health = join(dir, ".sddx-worktrees", healthId);
  mkdirSync(join(health, "tests"), { recursive: true });
  writeFileSync(
    join(health, "tests", "health.test.ts"),
    'import { expect, test } from "bun:test";\nimport { health } from "../health";\n\ntest("health", () => {\n  expect(health()).toEqual({ status: "ok" });\n});\n',
  );
  run(health, "bun", ["test", "tests/health.test.ts"], 1);
  sddx(health, "task", "phase", healthId, "RED", "--test-exit", "1");
  sddx(health, "red-check", healthId);
  writeFileSync(
    join(health, "health.ts"),
    'export function health(): { status: string } {\n  return { status: "ok" };\n}\n',
  );
  run(health, "bun", ["test", "tests/health.test.ts"]);
  sddx(health, "task", "phase", healthId, "GREEN", "--test-exit", "0");
  sddx(health, "task", "phase", healthId, "VERIFY");
  sddx(health, "verify", healthId);

  const ping = join(dir, ".sddx-worktrees", pingId);
  mkdirSync(join(ping, "tests"), { recursive: true });
  writeFileSync(
    join(ping, "tests", "ping.test.ts"),
    'import { expect, test } from "bun:test";\nimport { ping } from "../ping";\n\ntest("ping", () => {\n  expect(ping()).toBe("pong");\n});\n',
  );
  run(ping, "bun", ["test", "tests/ping.test.ts"], 1);
  sddx(ping, "task", "phase", pingId, "RED", "--test-exit", "1");

  git("merge", "-q", "--no-ff", "-m", "merge run branch", `sddx/run-${created.goalId}`);
  writeFileSync(
    join(dir, ".sddx", "local", "fixture-ids.json"),
    `${JSON.stringify({ goalId: created.goalId, doneTaskId: healthId, redTaskId: pingId }, null, 2)}\n`,
  );
  return dir;
}

if (import.meta.main) {
  const root = process.cwd();
  const repo = buildV5Repo(root);
  const out = join(root, FIXTURE_PATH);
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  run(repo, "tar", ["-czf", out, "."]);
  const ids = readFileSync(join(repo, ".sddx", "local", "fixture-ids.json"), "utf8");
  console.log(`wrote ${FIXTURE_PATH} from ${repo}\n${ids}`);
}
