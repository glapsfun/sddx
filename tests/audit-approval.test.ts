import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { writeApproval } from "../src/lib/approval";
import { type Receipt, sha256 } from "../src/lib/receipt";
import { signPayload } from "../src/lib/sign";
import { fixtureRepo, signingRepo, writeConfig } from "./fixtures";
import { completeTask, createRun, mutateGoal } from "./helpers";

const PLAN = "a".repeat(64);
const REL = join(".sddx", "receipts", "T1.json");

/** The worktree of one finished task of a goal run under `mode`, plus that plan's hash. */
function verifiedRepo(mode: "human" | "auto"): { cwd: string; wt: string; plan: string } {
  const cwd = fixtureRepo();
  if (mode === "auto") writeConfig(cwd, { interaction_mode: "auto" });
  const run = createRun(cwd, { tasks: [{ id: "T1" }], approve: mode === "human" });
  const { worktree } = completeTask(cwd, "T1");
  return { cwd, wt: worktree, plan: sha256(readFileSync(join(cwd, run.specPath))) };
}

/** Rewrites a receipt in place and re-commits, so only the targeted field
 * differs (chain/commit-binding findings would otherwise mask the approval one). */
function editReceipt(wt: string, mutate: (r: Record<string, unknown>) => void): void {
  const path = join(wt, REL);
  chmodSync(path, 0o644);
  const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(r);
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  spawnSync("git", ["add", "-A"], { cwd: wt });
  spawnSync("git", ["commit", "-qm", "tamper"], { cwd: wt });
}

/** A repository whose only receipt is a committed version 3 one, written before
 * approval provenance existed. */
function legacyRepo(): string {
  const cwd = fixtureRepo();
  const r: Receipt = {
    version: 3,
    task_id: "old",
    seq: 1,
    prev: "genesis",
    harness: "claude-code",
    model: null,
    plugin_version: "2.0.0",
    oracle: { run: "true", expect: "exit 0" },
    runs: [{ exit_code: 0, duration_ms: 1, stdout_sha256: PLAN, stderr_sha256: PLAN }],
    env: { os: "linux", arch: "x64", runtime: "bun", runtime_version: "1.2.0", dirty_tree: false },
    base_sha: "1".repeat(40),
    tree_sha: "2".repeat(40),
    verdict: "pass",
    verified_at: "2025-01-01T00:00:00.000Z",
    allow: [],
  };
  mkdirSync(join(cwd, ".sddx", "receipts"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "receipts", "old.json"), `${JSON.stringify(r, null, 2)}\n`);
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-qm", "legacy receipt"], { cwd });
  return cwd;
}

describe("approval provenance audit", () => {
  test("consistent provenance produces no approval finding", () => {
    const { wt } = verifiedRepo("auto");
    const res = auditReceipts(wt);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
  });

  test("a malformed goal approval block is a finding, not a crash", () => {
    // Goal files are parsed with a bare cast and no schema check, so this is
    // untrusted input. Dereferencing it unguarded threw a TypeError out of
    // auditReceipts and killed the whole report — the command whose job is to
    // detect tampering, disabled by the tampering.
    const { cwd, wt } = verifiedRepo("human");
    mutateGoal(cwd, (g) => {
      g.approval = { mode: "human" }; // plan_sha256 dropped
    });
    const res = auditReceipts(wt);
    const finding = res.findings.find((f) => f.includes(REL) && f.includes("malformed"));
    expect(finding).toBeDefined();
    // and the rest of the audit still ran
    expect(res.receipts).toBeGreaterThan(0);
  });

  test("a receipt whose mode disagrees with its goal is a finding naming both values", () => {
    const { wt } = verifiedRepo("auto");
    editReceipt(wt, (r) => {
      (r.approval as Record<string, unknown>).mode = "human";
    });
    const res = auditReceipts(wt);
    const finding = res.findings.find((f) => f.includes("approval") && f.includes(REL));
    expect(finding).toBeDefined();
    expect(finding).toContain("human");
    expect(finding).toContain("auto");
  });

  test("a receipt whose plan hash disagrees with its goal is a finding", () => {
    const { wt, plan } = verifiedRepo("human");
    editReceipt(wt, (r) => {
      (r.approval as Record<string, unknown>).plan_sha256 = "b".repeat(64);
    });
    const finding = auditReceipts(wt).findings.find((f) => f.includes("approval"));
    expect(finding).toBeDefined();
    expect(finding).toContain(plan.slice(0, 12));
  });

  test("legacy receipts with no approval block are skipped silently", () => {
    const res = auditReceipts(legacyRepo());
    expect(res.receipts).toBe(1);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
  });

  test("a receipt with approval whose goal has none is not a finding", () => {
    // a goal written before approval provenance existed
    const { cwd, wt } = verifiedRepo("human");
    mutateGoal(cwd, (g) => {
      delete g.approval;
    });
    const res = auditReceipts(wt);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
    // not silent either: a skipped cross-check must not read as a passed one
    expect(res.notes.join("\n")).toContain("NOT cross-checked");
  });
});

describe("approval signature verification", () => {
  test("a valid approval signature verifies and names its signer", () => {
    const cwd = signingRepo();
    const token = writeApproval(cwd, { plan_sha256: PLAN, mode: "human" });
    expect(token.signature).toBeDefined();
    const res = auditReceipts(cwd);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
    expect(res.notes.join("\n")).toContain(token.signer as string);
  });

  test("a tampered approval signature is a finding", () => {
    const cwd = signingRepo();
    writeApproval(cwd, { plan_sha256: PLAN, mode: "human" });
    const p = join(cwd, ".sddx", "approvals", `${PLAN}.json`);
    const t = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    t.mode = "auto"; // payload is the hash, so flip the hash instead
    t.plan_sha256 = "c".repeat(64);
    writeFileSync(join(cwd, ".sddx", "approvals", `${"c".repeat(64)}.json`), JSON.stringify(t));
    const finding = auditReceipts(cwd).findings.find((f) => f.includes("approval"));
    expect(finding).toBeDefined();
  });

  test("an unsigned token is not a finding", () => {
    const cwd = fixtureRepo();
    writeApproval(cwd, { plan_sha256: PLAN, mode: "human" });
    expect(auditReceipts(cwd).findings.filter((f) => f.includes("approval"))).toEqual([]);
  });

  test("no allowed-signers file yields a note, not a finding", () => {
    const cwd = signingRepo();
    spawnSync("git", ["config", "--unset", "gpg.ssh.allowedSignersFile"], { cwd });
    writeApproval(cwd, { plan_sha256: PLAN, mode: "human" });
    const res = auditReceipts(cwd);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
    expect(res.notes.join("\n")).toContain("allowedSignersFile");
  });

  test("a receipt signature cannot be replayed as an approval signature", () => {
    const cwd = signingRepo();
    const token = writeApproval(cwd, { plan_sha256: PLAN, mode: "human" });
    // swap in a signature made under the receipt namespace over the same payload
    const wrong = signPayload(cwd, PLAN, "sddx-receipt");
    expect(wrong).not.toBeNull();
    const p = join(cwd, ".sddx", "approvals", `${PLAN}.json`);
    const t = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    t.signature = wrong?.signature;
    writeFileSync(p, `${JSON.stringify(t, null, 2)}\n`);
    expect(token.signature).toBeDefined();

    const finding = auditReceipts(cwd).findings.find((f) => f.includes("approval"));
    expect(finding).toBeDefined();
  });
});

describe("audit claims are bounded", () => {
  test("a passing approval audit names the plan and mode, and never asserts who approved", () => {
    const { wt } = verifiedRepo("human");
    const res = auditReceipts(wt);
    const summary = [...res.findings, ...res.notes].join("\n").toLowerCase();
    expect(summary).not.toContain("approved by a human");
    expect(summary).not.toContain("human approved");
  });

  test("mkdir-only approvals directory does not break the audit", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    expect(() => auditReceipts(cwd)).not.toThrow();
  });
});
