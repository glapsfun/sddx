// User-facing receipt audit: chain verification (schema, seq, prev-hash tree)
// plus commit binding — every receipt must be introduced by a commit and match
// its committed bytes (the chain alone cannot see tampering of the newest
// receipt, which no child hash references yet). Signature verification is
// opt-in and consumes only git exit codes.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalsDir, readApproval } from "./lib/approval";
import { findGoalForTask } from "./lib/goal";
import { receiptsDir, sha256, verifyChain } from "./lib/receipt";
import { verifySignature } from "./lib/sign";

export interface AuditResult {
  receipts: number;
  findings: string[];
  /** Informational (never findings): unsigned or unverifiable receipts. */
  notes: string[];
}

function gitLines(cwd: string, ...args: string[]): { ok: boolean; lines: string[]; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return { ok: false, lines: [], err: (r.stderr ?? "").trim() };
  return { ok: true, lines: (r.stdout ?? "").split("\n").filter(Boolean), err: "" };
}

/**
 * Approval provenance: every receipt carrying an `approval` block must agree
 * with its goal on both `mode` and `plan_sha256`, and every signed approval
 * token must verify under the `sddx-approval` namespace.
 *
 * What a clean result establishes: which plan this work descends from, which
 * mode it ran under, and — where a signature is present and valid — that it was
 * produced by the named signer's key. It does NOT establish that a particular
 * human approved anything; any caller can write an unsigned token, and only a
 * touch-required key makes signing an act a model's own shell cannot perform.
 * Findings are worded to stay inside that claim.
 */
function auditApprovals(cwd: string, findings: string[], notes: string[]): void {
  const receipts = receiptsDir(cwd);
  if (existsSync(receipts)) {
    for (const file of readdirSync(receipts).filter((f) => f.endsWith(".json"))) {
      const rel = join(".sddx", "receipts", file);
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(readFileSync(join(receipts, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue; // chain verification already reports unparseable receipts
      }
      const a = r.approval as Record<string, unknown> | undefined;
      // pre-v4 receipts predate provenance — skipped, never a finding
      if (!a) continue;
      const goal = findGoalForTask(cwd, String(r.task_id));
      // `.sddx/goals/` is deliberately never committed, so in a fresh clone or
      // CI — exactly where audits run — there is nothing to compare against.
      // That cannot be a finding (the receipt isn't wrong), but it MUST NOT be
      // silent either: a silent skip reads as "provenance checked, all good"
      // when nothing was checked at all.
      if (!goal?.approval) {
        notes.push(
          `${rel}: approval records mode "${String(a.mode)}" / plan ${String(a.plan_sha256).slice(0, 12)} — NOT cross-checked (its goal file is absent; goal state is local-only and never committed)`,
        );
        continue;
      }
      if (a.mode !== goal.approval.mode) {
        findings.push(
          `${rel}: approval mode disagrees with its goal — receipt says "${String(a.mode)}", goal ${goal.id} says "${goal.approval.mode}"`,
        );
      }
      if (a.plan_sha256 !== goal.approval.plan_sha256) {
        findings.push(
          `${rel}: approval plan hash disagrees with its goal — receipt says ${String(a.plan_sha256).slice(0, 12)}, goal ${goal.id} says ${goal.approval.plan_sha256.slice(0, 12)}`,
        );
      }
    }
  }

  const tokens = approvalsDir(cwd);
  if (!existsSync(tokens)) return;
  for (const file of readdirSync(tokens).filter((f) => f.endsWith(".json"))) {
    const rel = join(".sddx", "approvals", file);
    const hash = file.slice(0, -".json".length);
    const token = readApproval(cwd, hash);
    if (!token) {
      findings.push(`${rel}: approval token is unreadable or its recorded hash does not match`);
      continue;
    }
    if (!token.signature || !token.signer) continue; // unsigned is not a finding
    const verdict = verifySignature(
      cwd,
      token.plan_sha256,
      { signature: token.signature, signer: token.signer },
      "sddx-approval",
    );
    if (verdict === "invalid") {
      findings.push(`${rel}: approval signature is invalid`);
    } else if (verdict === "unverifiable") {
      notes.push(
        `${rel}: approval signed by ${token.signer} — set gpg.ssh.allowedSignersFile to verify`,
      );
    } else {
      notes.push(`${rel}: approval signature valid (signer ${token.signer})`);
    }
  }
}

export function auditReceipts(
  cwd: string,
  opts: { signatures?: boolean; ci?: boolean } = {},
): AuditResult {
  const findings = verifyChain(cwd).map((f) => `chain: ${f}`);
  const notes: string[] = [];
  const dir = receiptsDir(cwd);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];

  // Deleting the newest receipt leaves no dangling child hash, so the chain
  // alone cannot see it — compare HEAD-tracked receipts against the working tree.
  const tracked = gitLines(cwd, "ls-tree", "-r", "--name-only", "HEAD", "--", ".sddx/receipts");
  if (tracked.ok) {
    for (const rel of tracked.lines) {
      if (rel.endsWith(".json") && !existsSync(join(cwd, rel))) {
        findings.push(`${rel}: committed receipt missing from working tree — receipt deleted`);
      }
    }
  }

  for (const file of files) {
    const rel = join(".sddx", "receipts", file);
    // signature verification runs before the commit-binding checks below — their
    // `continue`s must not hide an invalid signature on an unbound receipt
    let raw: string | null = null;
    try {
      raw = readFileSync(join(cwd, rel), "utf8");
    } catch {
      // chain verification already reports unreadable receipts
    }
    if (raw !== null && raw.includes('"signature"')) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // chain verification already reports unparseable receipts
      }
      if (parsed && typeof parsed.signature === "string" && typeof parsed.signer === "string") {
        const { signature, signer, ...unsigned } = parsed; // rest spread keeps key order
        const payload = sha256(`${JSON.stringify(unsigned, null, 2)}\n`);
        // destructured bindings are `unknown` under Record<string, unknown> — the
        // typeof guard above makes these casts safe
        const verdict = verifySignature(cwd, payload, {
          signature: signature as string,
          signer: signer as string,
        });
        if (verdict === "invalid") findings.push(`${rel}: embedded receipt signature is invalid`);
        if (verdict === "unverifiable")
          notes.push(`${rel}: signed by ${signer} — set gpg.ssh.allowedSignersFile to verify`);
      } else {
        notes.push(`${rel}: unsigned`);
      }
    } else if (raw !== null) {
      notes.push(`${rel}: unsigned`);
    }
    const log = gitLines(cwd, "log", "--format=%H", "--", rel);
    if (!log.ok) {
      findings.push(`${rel}: commit binding failed: ${log.err}`);
      continue;
    }
    const introducing = log.lines.at(-1);
    if (!introducing) {
      findings.push(`${rel}: not bound to any commit — an uncommitted receipt is unverifiable`);
      continue;
    }
    const dirty = gitLines(cwd, "status", "--porcelain", "--", rel);
    if (dirty.ok && dirty.lines.length > 0) {
      findings.push(`${rel}: working tree differs from committed state — receipt bytes tampered`);
    }
    if (opts.signatures) {
      const v = spawnSync("git", ["verify-commit", introducing], { cwd });
      if (v.status !== 0) {
        findings.push(`${rel}: binding commit ${introducing.slice(0, 12)} has no valid signature`);
      }
    }
  }
  auditApprovals(cwd, findings, notes);

  if (opts.ci) {
    const tasksDir = join(cwd, ".sddx", "tasks");
    if (existsSync(tasksDir)) {
      for (const f of readdirSync(tasksDir).filter((x) => x.endsWith(".json"))) {
        const rel = join(".sddx", "tasks", f);
        try {
          const t = JSON.parse(readFileSync(join(tasksDir, f), "utf8")) as {
            id?: string;
            phase?: string;
          };
          if (t.phase === "DONE" && !existsSync(join(dir, `${t.id}.json`))) {
            findings.push(`${rel}: task is DONE without a receipt — completion unproven`);
          }
        } catch {
          findings.push(`${rel}: unreadable task file`);
        }
      }
    }
  }
  return { receipts: files.length, findings, notes };
}
