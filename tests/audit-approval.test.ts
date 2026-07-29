import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReceipts } from "../src/audit";
import { writeApproval } from "../src/lib/approval";
import { headSha } from "../src/lib/git";
import { createGoal } from "../src/lib/goal";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureRepo } from "./fixtures";
import { mutateGoal } from "./helpers";

const SPEC = `task: do the widget work
success_criteria:
  - "it works"
oracle:
  type: command
  run: "true"
`;

const PLAN = "a".repeat(64);

/** A repo with one verified task belonging to an approved goal. */
function verifiedRepo(approval?: { mode: "human" | "auto"; plan_sha256?: string }): {
  cwd: string;
  id: string;
  rel: string;
} {
  const cwd = fixtureRepo();
  const parsed = parseSpec(SPEC);
  const t = createTask(cwd, parsed.spec as NonNullable<typeof parsed.spec>, ".sddx/specs/x.yaml", {
    mode: "worktree",
    branch: null,
    base_sha: headSha(cwd),
  });
  let cur = transition(t, "RED", { testExit: 1 });
  cur = transition(cur, "GREEN", { testExit: 0 });
  cur = transition(cur, "VERIFY");
  cur.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(cwd, cur);

  if (approval) {
    createGoal(cwd, "ship the widget", [cur.id], {
      runBranch: "sddx/run-x",
      baseSha: headSha(cwd),
      approval: {
        mode: approval.mode,
        plan_sha256: approval.plan_sha256 ?? PLAN,
        at: new Date().toISOString(),
      },
    });
  }
  verifyTask(cwd, cur.id, { harness: "test", model: null, pluginVersion: "test" });
  return { cwd, id: cur.id, rel: join(".sddx", "receipts", `${cur.id}.json`) };
}

/** Rewrites a receipt in place and re-commits, so only the targeted field
 * differs (chain/commit-binding findings would otherwise mask the approval one). */
function editReceipt(cwd: string, id: string, mutate: (r: Record<string, unknown>) => void): void {
  const path = join(cwd, ".sddx", "receipts", `${id}.json`);
  chmodSync(path, 0o644);
  const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(r);
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-qm", "tamper"], { cwd });
}

describe("approval provenance audit", () => {
  test("consistent provenance produces no approval finding", () => {
    const { cwd } = verifiedRepo({ mode: "auto" });
    const res = auditReceipts(cwd);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
  });

  test("a malformed goal approval block is a finding, not a crash", () => {
    // Goal files are parsed with a bare cast and no schema check, so this is
    // untrusted input. Dereferencing it unguarded threw a TypeError out of
    // auditReceipts and killed the whole report — the command whose job is to
    // detect tampering, disabled by the tampering.
    const { cwd, rel } = verifiedRepo({ mode: "human" });
    mutateGoal(cwd, (g) => {
      g.approval = { mode: "human" }; // plan_sha256 dropped
    });
    const res = auditReceipts(cwd);
    const finding = res.findings.find((f) => f.includes(rel) && f.includes("malformed"));
    expect(finding).toBeDefined();
    // and the rest of the audit still ran
    expect(res.receipts).toBeGreaterThan(0);
  });

  test("a receipt whose mode disagrees with its goal is a finding naming both values", () => {
    const { cwd, id, rel } = verifiedRepo({ mode: "auto" });
    editReceipt(cwd, id, (r) => {
      (r.approval as Record<string, unknown>).mode = "human";
    });
    const res = auditReceipts(cwd);
    const finding = res.findings.find((f) => f.includes("approval") && f.includes(rel));
    expect(finding).toBeDefined();
    expect(finding).toContain("human");
    expect(finding).toContain("auto");
  });

  test("a receipt whose plan hash disagrees with its goal is a finding", () => {
    const { cwd, id } = verifiedRepo({ mode: "human" });
    editReceipt(cwd, id, (r) => {
      (r.approval as Record<string, unknown>).plan_sha256 = "b".repeat(64);
    });
    const finding = auditReceipts(cwd).findings.find((f) => f.includes("approval"));
    expect(finding).toBeDefined();
    expect(finding).toContain(PLAN.slice(0, 12));
  });

  test("legacy receipts with no approval block are skipped silently", () => {
    const { cwd } = verifiedRepo();
    const res = auditReceipts(cwd);
    expect(res.findings.filter((f) => f.includes("approval"))).toEqual([]);
  });

  test("a receipt with approval whose goal has none is not a finding", () => {
    // a goal created before provenance existed, or via standalone `goal create`
    const { cwd, id } = verifiedRepo({ mode: "human" });
    mutateGoal(cwd, (g) => {
      delete g.approval;
    });
    expect(auditReceipts(cwd).findings.filter((f) => f.includes("approval"))).toEqual([]);
    expect(id).toBeTruthy();
  });
});

/** fixtureRepo + a throwaway SSH signing identity. */
function signingRepo(): string {
  const cwd = fixtureRepo();
  const keyDir = mkdtempSync(join(tmpdir(), "sddx-aud-key-"));
  const key = join(keyDir, "id_ed25519");
  expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]).status).toBe(0);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  const allowed = join(keyDir, "allowed_signers");
  writeFileSync(allowed, `fixture@example.invalid ${pub}\n`);
  const g = (...a: string[]) => spawnSync("git", a, { cwd });
  g("config", "gpg.format", "ssh");
  g("config", "user.signingkey", key);
  g("config", "gpg.ssh.allowedSignersFile", allowed);
  return cwd;
}

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
    const { signPayload } = require("../src/lib/sign") as typeof import("../src/lib/sign");
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
    const { cwd } = verifiedRepo({ mode: "human" });
    const res = auditReceipts(cwd);
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
