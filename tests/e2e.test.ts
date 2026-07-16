import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";
import { sha256, validateReceipt, verifyChain } from "../src/lib/receipt";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const CLI_DIST = join(repoRoot, "dist/cli.mjs");

function run(cwd: string, runtime: string[], ...args: string[]): string {
  const r = spawnSync(runtime[0]!, [...runtime.slice(1), ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

function completeTask(cwd: string, runtime: string[], n: number): string {
  // A real mini-task: check<n>.js requires greet<n>.js (RED), then we write it (GREEN).
  writeFileSync(
    join(cwd, `spec${n}.yaml`),
    `task: add greet ${n}\nsuccess_criteria:\n  - "node check${n}.js exits 0"\noracle:\n  type: command\n  run: "node check${n}.js"\n`,
  );
  const id = /created (\S+)/.exec(run(cwd, runtime, "task", "create", "--spec", `spec${n}.yaml`))![1]!;

  writeFileSync(join(cwd, `check${n}.js`), `require("./greet${n}.js");\n`);
  const red = spawnSync("node", [`check${n}.js`], { cwd });
  expect(red.status).not.toBe(0); // genuinely failing first
  run(cwd, runtime, "task", "phase", id, "RED", "--test-exit", String(red.status));

  writeFileSync(join(cwd, `greet${n}.js`), "module.exports = 'hello';\n");
  const green = spawnSync("node", [`check${n}.js`], { cwd });
  expect(green.status).toBe(0);
  run(cwd, runtime, "task", "phase", id, "GREEN", "--test-exit", "0");
  run(cwd, runtime, "task", "phase", id, "VERIFY");
  run(cwd, runtime, "verify", id);

  // merge back to main so the next task branches from a repo containing this receipt
  spawnSync("git", ["switch", "-q", "main"], { cwd });
  spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], { cwd });
  return id;
}

test("M1 oracle: two real tasks end-to-end — receipts validate, chain verifies, commits are atomic", () => {
  const cwd = fixtureRepo();
  const id1 = completeTask(cwd, ["bun", CLI_SRC], 1);

  // receipt validates against schema, first link is genesis
  const r1Path = join(cwd, ".sddx", "receipts", `${id1}.json`);
  const r1 = JSON.parse(readFileSync(r1Path, "utf8"));
  expect(validateReceipt(r1)).toEqual([]);
  expect(r1.prev).toBe("genesis");

  // the task's commit is atomic: code + spec + task + receipt
  const commitOf = spawnSync(
    "git", ["log", "--format=%H", "-1", "--", `.sddx/receipts/${id1}.json`],
    { cwd, encoding: "utf8" },
  ).stdout.trim();
  const files = spawnSync(
    "git", ["show", "--name-only", "--format=", commitOf],
    { cwd, encoding: "utf8" },
  ).stdout.trim().split("\n");
  expect(files).toContain("greet1.js");
  expect(files).toContain("check1.js");
  expect(files).toContain(`.sddx/specs/${id1}.yaml`);
  expect(files).toContain(`.sddx/tasks/${id1}.json`);
  expect(files).toContain(`.sddx/receipts/${id1}.json`);

  // second task via the COMMITTED dist bundle under plain node (launcher parity)
  const id2 = completeTask(cwd, ["node", CLI_DIST], 2);
  const r2 = JSON.parse(readFileSync(join(cwd, ".sddx", "receipts", `${id2}.json`), "utf8"));
  expect(r2.seq).toBe(2);
  expect(r2.prev).toBe(sha256(readFileSync(r1Path)));
  expect(verifyChain(cwd)).toEqual([]);
});
