import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { headSha } from "../src/lib/git";
import type { Receipt } from "../src/lib/receipt";
import { signPayload, verifySignature } from "../src/lib/sign";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";

/** fixtureRepo + a throwaway SSH signing identity wired into git config. */
function signingRepo() {
  const cwd = fixtureRepo();
  const keyDir = mkdtempSync(join(tmpdir(), "sddx-key-"));
  const key = join(keyDir, "id_ed25519");
  const kg = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]);
  expect(kg.status).toBe(0);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  const allowed = join(keyDir, "allowed_signers");
  writeFileSync(allowed, `fixture@example.invalid ${pub}\n`);
  const g = (...a: string[]) => spawnSync("git", a, { cwd });
  g("config", "gpg.format", "ssh");
  g("config", "user.signingkey", key);
  g("config", "gpg.ssh.allowedSignersFile", allowed);
  return cwd;
}

function verifiedTask(cwd: string) {
  const spec = parseSpec(
    'task: signed fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n',
  ).spec!;
  let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
    mode: "none",
    branch: null,
    base_sha: headSha(cwd),
  });
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(cwd, t);
  writeFileSync(join(cwd, "impl.txt"), "code\n");
  return verifyTask(cwd, t.id, { pluginVersion: "0.2.0" });
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
    const res = verifiedTask(cwd);
    const receipt = JSON.parse(readFileSync(res.receiptPath!, "utf8")) as Receipt;
    expect(receipt.signature).toBeUndefined();
    expect(auditReceipts(cwd).findings).toEqual([]); // absence never fails
  });

  test("configured repo embeds a signature audit accepts; tampering is caught", () => {
    const cwd = signingRepo();
    const res = verifiedTask(cwd);
    const receipt = JSON.parse(readFileSync(res.receiptPath!, "utf8")) as Receipt;
    expect(receipt.signature).toContain("SSH SIGNATURE");
    expect(receipt.signer).toBe("fixture@example.invalid");
    expect(auditReceipts(cwd).findings).toEqual([]);

    // flip a semantic value the signature covers — chain sees nothing (no child
    // references this receipt yet); the embedded signature must scream
    chmodSync(res.receiptPath!, 0o644);
    writeFileSync(
      res.receiptPath!,
      readFileSync(res.receiptPath!, "utf8").replace(
        '"harness": "claude-code"',
        '"harness": "claude-codex"',
      ),
    );
    const findings = auditReceipts(cwd).findings;
    expect(findings.some((f) => f.includes("signature"))).toBe(true);
  });
});
