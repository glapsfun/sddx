import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { worktreeTree } from "../src/lib/proof";
import { fixtureRepo } from "./fixtures";
import { CLI, createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const RUN = "sddx/run-2026-01-01-test-goal";

function commitFile(cwd: string, rel: string, text: string): void {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), text);
  git(cwd, "add", rel);
  git(cwd, "commit", "-qm", `add ${rel}`);
}

describe("what verify proves", () => {
  scenario("task-verification", "Type change outside scope", () => {
    const cwd = fixtureRepo();
    commitFile(cwd, "src/app.ts", "export const app = 1;\n");
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    rmSync(join(wt, "src", "app.ts"));
    symlinkSync(join("..", doneFile("T1")), join(wt, "src", "app.ts"));
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/app.ts");
  });

  scenario("task-verification", "Non-ASCII file names", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", run: "sh tests/é.test.sh" }] });
    const wt = startTask(cwd, "T1");
    mkdirSync(join(wt, "tests"));
    writeFileSync(join(wt, "tests", "é.test.sh"), `test -f ${doneFile("T1")}\n`);
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.stderr).not.toContain("outside");
    expect(r.status).toBe(0);
    expect((readTaskState(cwd, "T1").verified as { test_files: string[] }).test_files).toEqual([
      "tests/é.test.sh",
    ]);
  });

  scenario("task-verification", "Committed change under .sddx", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    const spec = join(".sddx", "specs", "2026-01-01-test-goal.md");
    writeFileSync(join(wt, spec), `${readFileSync(join(wt, spec), "utf8")}\nextra scope\n`);
    git(wt, "add", spec);
    git(wt, "commit", "-qm", "widen the plan");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(spec);
  });

  scenario("task-verification", "Task file oracle edited", () => {
    const cwd = fixtureRepo();
    const marker = join(cwd, "oracle-ran");
    createRun(cwd, { tasks: [{ id: "T1", run: `touch ${marker}; test -f T1.done` }] });
    const wt = startTask(cwd, "T1");
    const path = join(wt, ".sddx", "tasks", "T1.json");
    const t = JSON.parse(readFileSync(path, "utf8"));
    t.oracle.run = "true";
    writeFileSync(path, JSON.stringify(t, null, 2));
    const r = sddx(cwd, "verify", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle in its state file differs from the approved spec");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the proof worktree", () => {
  test("a leftover proof directory git no longer tracks neither breaks verify nor outlives sweep", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    const wt = startTask(cwd, "T1");
    const leftover = join(cwd, ".sddx-worktrees", "T1--proof");
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "stale.txt"), "from a killed run\n");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(existsSync(leftover)).toBe(false);

    const other = join(cwd, ".sddx-worktrees", "T2--proof");
    mkdirSync(other, { recursive: true });
    sddx(cwd, "sweep");
    expect(existsSync(other)).toBe(true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(other, old, old);
    sddx(cwd, "sweep");
    expect(existsSync(other)).toBe(false);
  });

  test("sweep removes a dead verify's locked proof worktree, even with its directory gone", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const dead = spawnSync("true").pid;
    const proof = join(cwd, ".sddx-worktrees", "T1--proof");
    git(
      cwd,
      "worktree",
      "add",
      "-q",
      "--detach",
      "--lock",
      "--reason",
      `sddx verify pid ${dead} on ${hostname()}`,
      proof,
      "HEAD",
    );
    rmSync(proof, { recursive: true, force: true });
    sddx(cwd, "sweep");
    expect(git(cwd, "worktree", "list", "--porcelain")).not.toContain("T1--proof");
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
  });

  scenario(
    "task-verification",
    "Sweep during a running proof",
    async () => {
      const cwd = fixtureRepo();
      createRun(cwd, { tasks: [{ id: "T1", run: `test -f ${doneFile("T1")} && sleep 2` }] });
      const wt = startTask(cwd, "T1");
      writeFileSync(join(wt, doneFile("T1")), "done\n");
      const proc = Bun.spawn(["bun", CLI, "verify", "T1"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const proof = join(cwd, ".sddx-worktrees", "T1--proof");
      for (let i = 0; i < 100 && !existsSync(proof); i += 1) await Bun.sleep(50);
      expect(existsSync(proof)).toBe(true);
      const sweep = sddx(cwd, "sweep");
      expect(sweep.stdout).not.toContain("T1--proof\n");
      expect(existsSync(proof)).toBe(true);
      expect(await proc.exited).toBe(0);
      expect(existsSync(proof)).toBe(false);
    },
    30_000,
  );
});

describe("what review accepts", () => {
  scenario("task-review", "Forged proof record", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, "unproven.txt"), "never verified\n");
    const path = join(wt, ".sddx", "tasks", "T1.json");
    const t = JSON.parse(readFileSync(path, "utf8"));
    const zeros = "0".repeat(64);
    t.phase = "IN_REVIEW";
    t.verified = {
      base_sha: t.workspace.base_sha,
      tree_sha: worktreeTree(wt),
      test_files: [],
      red: { exit_code: 1, stdout_sha256: zeros, stderr_sha256: zeros },
      green: [{ exit_code: 0, duration_ms: 1, stdout_sha256: zeros, stderr_sha256: zeros }],
      at: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(t, null, 2));
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no boundary proof recorded by sddx verify");
    expect(git(cwd, "branch", "--list", RUN)).toContain(RUN);
    expect(spawnSync("git", ["cat-file", "-e", `${RUN}:unproven.txt`], { cwd }).status).not.toBe(0);
  });
});

describe("what finalize commits", () => {
  scenario("task-review", "Only proven work is merged", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const sneaky = join(".sddx", "specs", "2026-01-02-sneaky.md");
    writeFileSync(join(wt, sneaky), "# Never reviewed\n");
    writeFileSync(join(wt, ".sddx", "config.json"), '{"schema_version": "2.0"}\n');
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    for (const rel of [sneaky, ".sddx/config.json"]) {
      expect(spawnSync("git", ["cat-file", "-e", `${RUN}:${rel}`], { cwd }).status).not.toBe(0);
    }
    const receipt = JSON.parse(readFileSync(join(wt, ".sddx", "receipts", "T1.json"), "utf8"));
    const finalize = git(
      cwd,
      "log",
      "--diff-filter=A",
      "--format=%H",
      "sddx/T1",
      "--",
      ".sddx/receipts/T1.json",
    );
    expect(
      git(cwd, "diff", "--name-only", receipt.boundary.tree_sha, finalize).split("\n").sort(),
    ).toEqual([".sddx/receipts/T1.json", ".sddx/tasks/T1.json"]);
  });

  test("a pre-commit hook cannot change what was reviewed", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const hook = join(cwd, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\necho reformatted > ${doneFile("T1")}\ngit add ${doneFile("T1")}\n`,
      {
        mode: 0o755,
      },
    );
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    expect(git(cwd, "show", `${RUN}:${doneFile("T1")}`)).toBe("done");
    expect(git(cwd, "show", `sddx/T1:${doneFile("T1")}`)).toBe("done");
  });

  scenario("task-review", "Commit failure leaves the task in review", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    git(cwd, "config", "commit.gpgsign", "true");
    git(cwd, "config", "gpg.program", "false");
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(1);
    expect(readTaskState(cwd, "T1").phase).toBe("IN_REVIEW");
    expect(existsSync(join(wt, ".sddx", "receipts", "T1.json"))).toBe(false);
    git(cwd, "config", "commit.gpgsign", "false");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    expect(readTaskState(cwd, "T1").phase).toBe("DONE");
  });

  test("a scratch checkout of the run branch left by a killed integration does not block the next", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    git(cwd, "worktree", "add", "-q", join(cwd, ".sddx-worktrees", "integrate-T0"), RUN);
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`merged into ${RUN}`);
    expect(existsSync(join(cwd, ".sddx-worktrees", "integrate-T0"))).toBe(false);
  });

  scenario("task-review", "Run branch checked out elsewhere", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    git(cwd, "checkout", "-q", RUN);
    const r = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`run branch ${RUN} is checked out`);
    expect(readTaskState(cwd, "T1").phase).toBe("IN_REVIEW");
    git(cwd, "checkout", "-q", "main");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(0);
    expect(git(cwd, "show", `${RUN}:${doneFile("T1")}`)).toBe("done");
  });
});
