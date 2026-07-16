import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chainHead,
  type Receipt,
  sha256,
  validateReceipt,
  verifyChain,
  writeReceipt,
} from "../src/lib/receipt";

function makeReceipt(cwd: string, taskId: string): Receipt {
  const head = chainHead(cwd);
  return {
    version: 1,
    task_id: taskId,
    seq: head.seq + 1,
    prev: head.prevHash,
    harness: "claude-code",
    model: null,
    plugin_version: "0.0.1",
    oracle: { run: "true", expect: "exit 0" },
    exit_code: 0,
    duration_ms: 12,
    stdout_sha256: sha256(""),
    stderr_sha256: sha256(""),
    base_sha: "a".repeat(40),
    tree_sha: "b".repeat(40),
    verdict: "pass",
    verified_at: new Date().toISOString(),
  };
}

describe("receipt chain", () => {
  test("first receipt links to genesis; second links to first's file hash", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-receipt-"));
    const r1 = makeReceipt(cwd, "t1");
    expect(r1.prev).toBe("genesis");
    const p1 = writeReceipt(cwd, r1);
    const r2 = makeReceipt(cwd, "t2");
    expect(r2.seq).toBe(2);
    expect(r2.prev).toBe(sha256(readFileSync(p1)));
    writeReceipt(cwd, r2);
    expect(verifyChain(cwd)).toEqual([]);
  });

  test("receipts are immutable — second write for same task throws", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-receipt-"));
    writeReceipt(cwd, makeReceipt(cwd, "t1"));
    expect(() => writeReceipt(cwd, makeReceipt(cwd, "t1"))).toThrow(/immutable/);
  });

  test("tampering breaks the chain loudly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-receipt-"));
    const p1 = writeReceipt(cwd, makeReceipt(cwd, "t1"));
    writeReceipt(cwd, makeReceipt(cwd, "t2"));
    chmodSync(p1, 0o644);
    const doctored = JSON.parse(readFileSync(p1, "utf8")) as Receipt;
    doctored.exit_code = 1;
    writeFileSync(p1, `${JSON.stringify(doctored, null, 2)}\n`);
    const errors = verifyChain(cwd);
    expect(errors.some((e) => e.includes("prev"))).toBe(true);
  });

  test("validateReceipt catches missing/wrong fields", () => {
    expect(validateReceipt({}).length).toBeGreaterThan(0);
    const cwd = mkdtempSync(join(tmpdir(), "sddx-receipt-"));
    const good = makeReceipt(cwd, "t1");
    expect(validateReceipt(good)).toEqual([]);
    expect(validateReceipt({ ...good, verdict: "maybe" }).join(" ")).toContain("verdict");
    expect(validateReceipt({ ...good, stdout_sha256: "xyz" }).join(" ")).toContain("stdout_sha256");
  });

  test("gap in seq is an error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-receipt-"));
    const r = makeReceipt(cwd, "t1");
    r.seq = 2; // skip 1
    writeReceipt(cwd, r);
    expect(verifyChain(cwd).join(" ")).toContain("seq");
  });
});
