// User-facing receipt audit: chain verification (schema, seq, prev-hash tree)
// plus commit binding — every receipt must be introduced by a commit and match
// its committed bytes (the chain alone cannot see tampering of the newest
// receipt, which no child hash references yet). Signature verification is
// opt-in and consumes only git exit codes.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
