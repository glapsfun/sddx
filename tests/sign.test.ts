import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { auditReceipts } from "../src/audit";
import type { Receipt } from "../src/lib/receipt";
import { signPayload, verifySignature } from "../src/lib/sign";
import { fixtureRepo, signingRepo } from "./fixtures";
import { completeTask, createRun } from "./helpers";

function finishedTask(cwd: string): { worktree: string; receiptPath: string } {
  createRun(cwd, { tasks: [{ id: "T1" }] });
  return completeTask(cwd, "T1");
}

describe("receipt signing", () => {
  test("sign/verify round-trip; wrong payload is invalid", () => {
    const cwd = signingRepo();
    const sig = signPayload(cwd, "payload-a");
    expect(sig).not.toBeNull();
    expect(sig!.signer).toBe("fixture@example.invalid");
    expect(verifySignature(cwd, "payload-a", sig!)).toBe("valid");
    expect(verifySignature(cwd, "payload-b", sig!)).toBe("invalid");
  });

  test("unconfigured repo signs nothing and receipts stay unsigned", () => {
    const cwd = fixtureRepo();
    expect(signPayload(cwd, "x")).toBeNull();
    const { worktree, receiptPath } = finishedTask(cwd);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
    expect(receipt.signature).toBeUndefined();
    expect(auditReceipts(worktree).findings).toEqual([]); // absence never fails
  });

  test("configured repo embeds a signature audit accepts; tampering is caught", () => {
    const cwd = signingRepo();
    const { worktree, receiptPath } = finishedTask(cwd);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
    expect(receipt.signature).toContain("SSH SIGNATURE");
    expect(receipt.signer).toBe("fixture@example.invalid");
    expect(auditReceipts(worktree).findings).toEqual([]);

    // flip a semantic value the signature covers — chain sees nothing (no child
    // references this receipt yet); the embedded signature must scream
    chmodSync(receiptPath, 0o644);
    writeFileSync(
      receiptPath,
      readFileSync(receiptPath, "utf8").replace(
        '"harness": "unknown"',
        '"harness": "claude-codex"',
      ),
    );
    const findings = auditReceipts(worktree).findings;
    expect(findings.some((f) => f.includes("signature"))).toBe(true);
  });
});
