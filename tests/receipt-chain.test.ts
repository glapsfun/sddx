import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Receipt, sha256, validateReceipt, writeReceipt } from "../src/lib/receipt";
import { fixtureRepo, signingRepo } from "./fixtures";
import { completeTask, createRun, goalSpec, sddx, writeSpec } from "./helpers";
import { scenario } from "./scenario";
import { extractV5Fixture } from "./v5-fixture";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const HEX = (c: string, n: number) => c.repeat(n);

/** A schema-valid historical receipt of version 3 or 4, chained by `prev`. */
function legacyReceipt(version: 3 | 4, id: string, seq: number, prev: string): Receipt {
  return {
    version,
    task_id: id,
    seq,
    prev,
    harness: "claude-code",
    model: null,
    plugin_version: version === 3 ? "2.0.0" : "4.0.0",
    oracle: { run: "exit 0", expect: "exit 0" },
    runs: [
      { exit_code: 0, duration_ms: 1, stdout_sha256: HEX("a", 64), stderr_sha256: HEX("b", 64) },
    ],
    env: { os: "linux", arch: "x64", runtime: "bun", runtime_version: "1.2.0", dirty_tree: false },
    base_sha: HEX("1", 40),
    tree_sha: HEX("2", 40),
    verdict: "pass",
    verified_at: "2025-01-01T00:00:00.000Z",
    allow: [],
    ...(version === 4
      ? {
          approval: {
            mode: "human" as const,
            plan_sha256: HEX("c", 64),
            assumptions: [],
            amendments: [] as never[],
          },
        }
      : {}),
  };
}

/** Commits a v3 then a v4 receipt to the repository's main branch, returning their file hashes. */
function commitHistory(cwd: string): { v3: string; v4: string } {
  const dir = join(cwd, ".sddx", "receipts");
  mkdirSync(dir, { recursive: true });
  const v3 = `${JSON.stringify(legacyReceipt(3, "old-3", 1, "genesis"), null, 2)}\n`;
  writeFileSync(join(dir, "old-3.json"), v3);
  const v4 = `${JSON.stringify(legacyReceipt(4, "old-4", 2, sha256(v3)), null, 2)}\n`;
  writeFileSync(join(dir, "old-4.json"), v4);
  git(cwd, "add", ".sddx/receipts");
  git(cwd, "commit", "-qm", "historical receipts");
  return { v3: sha256(v3), v4: sha256(v4) };
}

const receiptOf = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Receipt;

describe("receipt version 5", () => {
  scenario("receipt-chain", "Receipt contents", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree, receiptPath } = completeTask(cwd, "T1");
    const r = receiptOf(receiptPath);
    expect(r.version).toBe(5);
    expect(r.task_id).toBe("T1");
    expect(r.seq).toBe(1);
    expect(r.spec).toEqual({
      path: ".sddx/specs/2026-01-01-test-goal.md",
      goal_id: "2026-01-01-test-goal",
    });
    expect(r.approval?.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.boundary?.test_files).toEqual([]);
    expect(r.boundary?.red.exit_code).toBe(1);
    expect(r.runs?.[0]?.exit_code).toBe(0);
    expect(r.review).toMatchObject({ verdict: "pass", reviewer: "test" });
    expect(r.profile).toBe("default");
    expect(r.env?.runtime).toBe("bun");
    expect(validateReceipt(r)).toEqual([]);
    expect(sddx(worktree, "audit").status).toBe(0);
  });

  scenario("receipt-chain", "Version key retained", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const r = receiptOf(completeTask(cwd, "T1").receiptPath);
    const version = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ).version;
    expect(r.plugin_version).toBe(version);
  });

  scenario("receipt-chain", "Re-finalizing is refused", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree, receiptPath } = completeTask(cwd, "T1");
    const bytes = readFileSync(receiptPath);
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(1);
    expect(() => writeReceipt(worktree, receiptOf(receiptPath))).toThrow("immutable");
    expect(readFileSync(receiptPath).equals(bytes)).toBe(true);
  });

  test("a v5 receipt missing its boundary proof or review is invalid", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const r = receiptOf(completeTask(cwd, "T1").receiptPath) as unknown as Record<string, unknown>;
    expect(validateReceipt({ ...r, boundary: undefined })).toContain(
      "boundary: missing or invalid",
    );
    expect(validateReceipt({ ...r, review: undefined })).toContain("review: missing or invalid");
    expect(validateReceipt({ ...r, version: 4 })).toContain("spec: missing or invalid");
  });
});

describe("chain continuity", () => {
  scenario("receipt-chain", "First v6 receipt after v5 history", () => {
    const { dir: v5 } = extractV5Fixture();
    const legacy = readFileSync(join(v5, ".sddx", "receipts", "20261026-health-returns-ok.json"));
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "receipts"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "receipts", "20261026-health-returns-ok.json"), legacy);
    git(cwd, "add", ".sddx/receipts");
    git(cwd, "commit", "-qm", "v5 history");
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree, receiptPath } = completeTask(cwd, "T1");
    const r = receiptOf(receiptPath);
    expect(JSON.parse(legacy.toString()).version).toBe(4);
    expect(r.version).toBe(5);
    expect(r.seq).toBe(2);
    expect(r.prev).toBe(sha256(legacy));
    expect(sddx(worktree, "audit").status).toBe(0);
  });

  scenario("receipt-chain", "Fresh repository", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    expect(receiptOf(completeTask(cwd, "T1").receiptPath).prev).toBe("genesis");
  });
});

describe("audit across versions", () => {
  scenario("receipt-chain", "Mixed chain passes", () => {
    const cwd = fixtureRepo();
    const hashes = commitHistory(cwd);
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree, receiptPath } = completeTask(cwd, "T1");
    expect(receiptOf(receiptPath).prev).toBe(hashes.v4);
    const r = sddx(worktree, "audit");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 receipt(s) verified, chain intact");
  });

  scenario("receipt-chain", "Deleted receipt detected", () => {
    const cwd = fixtureRepo();
    commitHistory(cwd);
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    rmSync(join(worktree, ".sddx", "receipts", "old-4.json"), { force: true });
    const r = sddx(worktree, "audit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("T1.json: prev hash matches no receipt");
  });

  scenario("receipt-chain", "CI tamper gate", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree, receiptPath } = completeTask(cwd, "T1");
    chmodSync(receiptPath, 0o644);
    writeFileSync(
      receiptPath,
      readFileSync(receiptPath, "utf8").replace('"reviewer": "test"', '"reviewer": "forged"'),
    );
    expect(sddx(worktree, "audit", "--ci").status).toBe(1);
  });
});

describe("approval binding", () => {
  scenario("receipt-chain", "Unsigned human approval", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    expect(receiptOf(completeTask(cwd, "T1").receiptPath).approval?.binding).toBe("unsigned");
  });

  scenario("receipt-chain", "Signed human approval", () => {
    const cwd = signingRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    expect(receiptOf(completeTask(cwd, "T1").receiptPath).approval?.binding).toBe("signed");
  });

  scenario("receipt-chain", "Not provable", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, "2026-01-01-harness", goalSpec({ tasks: [{ id: "H1" }] }));
    expect(sddx(cwd, "plan", "approve", spec, "--harness", "claude-code").status).toBe(0);
    expect(sddx(cwd, "plan", "start", spec).status).toBe(0);
    const { worktree } = completeTask(cwd, "H1");
    const r = sddx(worktree, "audit");
    expect(r.stdout).toContain("human approval not provable");
    expect(r.stdout).toContain("harness claude-code (reported, not verified)");
  });

  scenario("receipt-chain", "Provable", () => {
    const cwd = signingRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    const r = sddx(worktree, "audit");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("human approval provable, signed by fixture@example.invalid");
  });

  scenario("receipt-chain", "Signed approval audited in a fresh clone", () => {
    const cwd = signingRepo();
    const { runBranch } = createRun(cwd, { tasks: [{ id: "T1" }] });
    const receipt = JSON.parse(readFileSync(completeTask(cwd, "T1").receiptPath, "utf8"));
    expect(receipt.approval.signer).toBe("fixture@example.invalid");
    expect(typeof receipt.approval.signature).toBe("string");
    const clone = join(cwd, "..", `${cwd.split("/").pop()}-clone`);
    expect(spawnSync("git", ["clone", "-q", "--branch", runBranch, cwd, clone]).status).toBe(0);

    const bare = sddx(clone, "audit", "--ci");
    expect(bare.stdout).toContain("signed approval cannot be checked here");
    expect(bare.status).toBe(0);

    git(
      clone,
      "config",
      "gpg.ssh.allowedSignersFile",
      git(cwd, "config", "gpg.ssh.allowedSignersFile"),
    );
    const configured = sddx(clone, "audit", "--ci");
    expect(configured.status).toBe(0);
    expect(configured.stdout).toContain(
      "human approval provable, signed by fixture@example.invalid",
    );
  });

  test("a missing allowed-signers file is not reported as an invalid approval", () => {
    const cwd = signingRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    git(cwd, "config", "--unset", "gpg.ssh.allowedSignersFile");
    const r = sddx(worktree, "audit", "--ci");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("signed approval cannot be checked here");
  });

  test("an auto-mode receipt says no person approved it", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "config.json"),
      '{"schema_version": "2.0", "interaction_mode": "auto"}\n',
    );
    createRun(cwd, { tasks: [{ id: "T1" }], approve: false });
    const { worktree } = completeTask(cwd, "T1");
    expect(sddx(worktree, "audit").stdout).toContain(
      "ran in auto mode; no person approved this plan",
    );
  });
});
