import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { chainHead, type Receipt, sha256, writeReceipt } from "../src/lib/receipt";
import { fixtureRepo } from "./fixtures";

function makeReceipt(cwd: string, taskId: string): Receipt {
  const head = chainHead(cwd);
  return {
    version: 2,
    task_id: taskId,
    seq: head.seq + 1,
    prev: head.prevHash,
    harness: "claude-code",
    model: null,
    plugin_version: "0.1.0",
    oracle: { run: "true", expect: "exit 0" },
    exit_code: 0,
    duration_ms: 12,
    stdout_sha256: sha256(""),
    stderr_sha256: sha256(""),
    base_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    verdict: "pass",
    verified_at: new Date().toISOString(),
    allow: [],
  };
}

const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function committedReceipts(count: number): { repo: string; paths: string[] } {
  const repo = fixtureRepo();
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    paths.push(writeReceipt(repo, makeReceipt(repo, `t${i}`)));
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", `receipt t${i}`);
  }
  return { repo, paths };
}

describe("auditReceipts", () => {
  test("clean committed chain passes", () => {
    const { repo } = committedReceipts(2);
    const res = auditReceipts(repo);
    expect(res.findings).toEqual([]);
    expect(res.receipts).toBe(2);
  });

  test("uncommitted receipt is a finding", () => {
    const { repo } = committedReceipts(1);
    writeReceipt(repo, makeReceipt(repo, "t2"));
    const res = auditReceipts(repo);
    expect(res.findings.join(" ")).toContain("not bound to any commit");
  });

  test("tampering the newest receipt is caught via committed-state diff", () => {
    const { repo, paths } = committedReceipts(2);
    const last = paths[1] as string;
    chmodSync(last, 0o644);
    const doctored = JSON.parse(readFileSync(last, "utf8")) as Receipt;
    doctored.exit_code = 99;
    writeFileSync(last, `${JSON.stringify(doctored, null, 2)}\n`);
    const res = auditReceipts(repo);
    expect(res.findings.join(" ")).toContain("tampered");
  });

  test("deleting the newest receipt is caught via HEAD-tracked comparison", () => {
    const { repo, paths } = committedReceipts(2);
    // the newest receipt has no child whose prev would dangle — chain alone is blind
    rmSync(paths[1] as string);
    const res = auditReceipts(repo);
    expect(res.findings.join(" ")).toContain("missing from working tree");
  });

  test("unsigned commits pass without --signatures and fail with it", () => {
    const { repo } = committedReceipts(1);
    expect(auditReceipts(repo).findings).toEqual([]);
    const res = auditReceipts(repo, { signatures: true });
    expect(res.findings.join(" ")).toContain("no valid signature");
  });

  test("signed chain passes with --signatures", () => {
    const { repo } = committedReceipts(0);
    // local ssh signing key, allowed-signers pinned inside the fixture
    const keyDir = join(repo, ".keys");
    mkdirSync(keyDir);
    const keyPath = join(keyDir, "sign");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
    const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
    writeFileSync(join(keyDir, "allowed_signers"), `fixture@example.invalid ${pub}\n`);
    g(repo, "config", "gpg.format", "ssh");
    g(repo, "config", "user.signingkey", keyPath);
    g(repo, "config", "commit.gpgsign", "true");
    g(repo, "config", "gpg.ssh.allowedSignersFile", join(keyDir, "allowed_signers"));
    writeReceipt(repo, makeReceipt(repo, "t1"));
    g(repo, "add", "-A");
    const c = g(repo, "commit", "-qm", "signed receipt");
    expect(c.status).toBe(0);
    const res = auditReceipts(repo, { signatures: true });
    expect(res.findings).toEqual([]);
  });
});
