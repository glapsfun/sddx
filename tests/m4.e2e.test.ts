// M4 oracle: on a fresh clone, a task completes under the hook gates, the board
// renders it deterministically, the audit passes on the intact chain — and fails
// loudly on tampering or deletion.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

const HOOKS = join(repoRoot, "dist", "hooks.mjs");
const CLI = join(repoRoot, "dist", "cli.mjs");

function sddx(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hook(cwd: string, sub: string, event: unknown): Record<string, unknown> {
  const r = spawnSync("bun", [HOOKS, sub], {
    input: JSON.stringify(event),
    encoding: "utf8",
  });
  const raw = (r.stdout ?? "").trim();
  return raw === "" ? {} : JSON.parse(raw);
}

const SPEC_YAML = `task: m4 full loop
context: []
success_criteria:
  - "oracle exits 0"
oracle:
  type: command
  run: "true"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
`;

function completedTask(): { repo: string; id: string } {
  const { clone: repo } = fixtureClone();
  writeFileSync(join(repo, "spec.yaml"), SPEC_YAML);
  const created = sddx(repo, "task", "create", "--spec", "spec.yaml", "--workspace", "none");
  expect(created.status).toBe(0);
  const id = /created (\S+) /.exec(created.stdout)?.[1] as string;

  // red → green earned through the recorder, exactly as hooks would observe it
  hook(repo, "record-test", {
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    tool_response: { exit_code: 1 },
    cwd: repo,
  });
  hook(repo, "record-test", {
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    tool_response: { exit_code: 0 },
    cwd: repo,
  });
  fakeRedCheck(repo, id);
  expect(sddx(repo, "task", "phase", id, "VERIFY").status).toBe(0);
  expect(sddx(repo, "verify", id).status).toBe(0);
  return { repo, id };
}

describe("M4 oracle", () => {
  test("task completes → board renders deterministically → audit passes", () => {
    const { repo, id } = completedTask();

    const board = sddx(repo, "board");
    expect(board.status).toBe(0);
    const rendered = readFileSync(join(repo, ".sddx", "BOARD.md"), "utf8");
    expect(rendered).toContain(`| ${id} | Completed | — | m4 full loop | none | 1 | #1 |`);

    // byte-identical re-render, reported as unchanged
    const again = sddx(repo, "board");
    expect(again.stdout).toContain("(unchanged)");
    expect(readFileSync(join(repo, ".sddx", "BOARD.md"), "utf8")).toBe(rendered);

    // session-start refreshes the board and stays inside the latency budget
    rmSync(join(repo, ".sddx", "BOARD.md"));
    const started = performance.now();
    hook(repo, "session-start", { cwd: repo });
    expect(performance.now() - started).toBeLessThan(200);
    expect(readFileSync(join(repo, ".sddx", "BOARD.md"), "utf8")).toBe(rendered);

    const audit = sddx(repo, "audit");
    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain("1 receipt(s) verified, chain intact");
  });

  test("tampered receipt fails the audit naming the file", () => {
    const { repo, id } = completedTask();
    const receipt = join(repo, ".sddx", "receipts", `${id}.json`);
    chmodSync(receipt, 0o644);
    writeFileSync(
      receipt,
      readFileSync(receipt, "utf8").replace('"exit_code": 0', '"exit_code": 9'),
    );
    const audit = sddx(repo, "audit");
    expect(audit.status).toBe(1);
    expect(audit.stderr).toContain(`${id}.json`);
  });

  test("deleted receipt breaks the chain loudly", () => {
    const { repo, id } = completedTask();
    // second task so the survivor's prev points at the deleted receipt
    writeFileSync(join(repo, "spec2.yaml"), SPEC_YAML.replace("m4 full loop", "second loop"));
    const created = sddx(repo, "task", "create", "--spec", "spec2.yaml", "--workspace", "none");
    const id2 = /created (\S+) /.exec(created.stdout)?.[1] as string;
    hook(repo, "record-test", {
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
      cwd: repo,
    });
    hook(repo, "record-test", {
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 0 },
      cwd: repo,
    });
    fakeRedCheck(repo, id2);
    expect(sddx(repo, "task", "phase", id2, "VERIFY").status).toBe(0);
    expect(sddx(repo, "verify", id2).status).toBe(0);

    rmSync(join(repo, ".sddx", "receipts", `${id}.json`));
    const audit = sddx(repo, "audit");
    expect(audit.status).toBe(1);
    expect(audit.stderr).toMatch(/prev hash matches no receipt|seq/);
  });
});
