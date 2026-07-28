import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { findGoalForTask } from "./goal";

export interface OracleRun {
  exit_code: number;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
}

export interface ReceiptEnv {
  os: string;
  arch: string;
  runtime: "bun" | "node";
  runtime_version: string;
  dirty_tree: boolean;
}

/** Approval provenance, denormalized onto the receipt so it states the
 * conditions it was produced under without needing the goal file to interpret
 * it. Absent for a task created outside any goal. */
export interface ReceiptApproval {
  /** The mode that actually applied. */
  mode: "human" | "auto";
  /** Whether a person approved this plan or the configured mode authorized it.
   * Absent on receipts written before it was recorded. */
  authorization?: "human-approval" | "auto";
  /** Set when `auto` was requested but a blast-radius bound armed the gate. */
  requested_mode?: "human" | "auto";
  degraded_reason?: string;
  /** The plan this work descends from — what an auditor checks it against. */
  plan_sha256: string;
  at?: string;
  /** Decisions resolved without asking, carried from the task's spec. */
  assumptions: string[];
  /** Reserved for per-node spec revisions approved mid-run; always empty here. */
  amendments: never[];
}

export interface Receipt {
  /** 1 = M1 schema; 2 adds `allow`; 3 replaces the single run with `runs[]` +
   * `env`; 4 adds `approval` (present only for a task belonging to a goal). */
  version: 1 | 2 | 3 | 4;
  task_id: string;
  seq: number;
  prev: string;
  harness: string;
  model: string | null;
  plugin_version: string;
  oracle: { run: string; expect: string };
  /** v1–v2 only: the single oracle run. v3 stores runs in `runs`. */
  exit_code?: number;
  duration_ms?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  /** v3 only: every oracle execution, in order; pass requires all zero exits. */
  runs?: OracleRun[];
  /** v3 only: environment evidence captured at verify time. */
  env?: ReceiptEnv;
  base_sha: string;
  tree_sha: string;
  verdict: "pass";
  verified_at: string;
  /** Required from version 2: the task's gate exemptions, empty when none. */
  allow?: string[];
  /** v3 optional, both-or-neither: SSH signature over the unsigned receipt's sha256. */
  signature?: string;
  signer?: string;
  /** v4 only, and only for a task belonging to a goal. */
  approval?: ReceiptApproval;
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const receiptsDir = (cwd: string): string => join(cwd, ".sddx", "receipts");
export const receiptPath = (cwd: string, taskId: string): string =>
  join(receiptsDir(cwd), `${taskId}.json`);

function listReceipts(cwd: string): Array<{ file: string; receipt: Receipt }> {
  const dir = receiptsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: join(dir, f),
      receipt: JSON.parse(readFileSync(join(dir, f), "utf8")) as Receipt,
    }))
    .sort((a, b) => a.receipt.seq - b.receipt.seq);
}

export function chainHead(cwd: string): { seq: number; prevHash: string } {
  const receipts = listReceipts(cwd);
  const last = receipts.at(-1);
  if (!last) return { seq: 0, prevHash: "genesis" };
  return { seq: last.receipt.seq, prevHash: sha256(readFileSync(last.file)) };
}

export function writeReceipt(cwd: string, r: Receipt): string {
  // a receipt is immutable the moment it is written — never let an invalid one in
  const schemaErrors = validateReceipt(r);
  if (schemaErrors.length > 0) {
    throw new Error(`refusing to write invalid receipt: ${schemaErrors.join("; ")}`);
  }
  const path = receiptPath(cwd, r.task_id);
  if (existsSync(path)) {
    throw new Error(`receipt for ${r.task_id} already exists — receipts are immutable`);
  }
  mkdirSync(receiptsDir(cwd), { recursive: true });
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  chmodSync(path, 0o444);
  return path;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

export function validateReceipt(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return ["receipt must be an object"];
  const r = raw as Record<string, unknown>;
  const need = (field: string, ok: boolean) => {
    if (!ok) errors.push(`${field}: missing or invalid`);
  };
  need("version", r.version === 1 || r.version === 2 || r.version === 3 || r.version === 4);
  const version = typeof r.version === "number" ? r.version : 0;
  if (version >= 2) {
    need(
      "allow",
      Array.isArray(r.allow) && (r.allow as unknown[]).every((p) => typeof p === "string"),
    );
  } else {
    need("allow", r.allow === undefined);
  }
  // `approval` only exists from v4; an older receipt carrying one is a forgery
  // or a corruption, not a newer reader's problem.
  if (version >= 4) {
    if (r.approval !== undefined) {
      const a = r.approval as Record<string, unknown>;
      need(
        "approval",
        typeof a === "object" &&
          a !== null &&
          (a.mode === "human" || a.mode === "auto") &&
          typeof a.plan_sha256 === "string" &&
          HEX64.test(a.plan_sha256) &&
          (a.requested_mode === undefined ||
            a.requested_mode === "human" ||
            a.requested_mode === "auto") &&
          (a.authorization === undefined ||
            a.authorization === "human-approval" ||
            a.authorization === "auto") &&
          Array.isArray(a.assumptions) &&
          (a.assumptions as unknown[]).every((x) => typeof x === "string") &&
          Array.isArray(a.amendments) &&
          (a.amendments as unknown[]).length === 0,
      );
    }
  } else {
    need("approval", r.approval === undefined);
  }
  if (version <= 2) {
    need("exit_code", typeof r.exit_code === "number");
    need("duration_ms", typeof r.duration_ms === "number" && (r.duration_ms as number) >= 0);
    need(
      "stdout_sha256",
      typeof r.stdout_sha256 === "string" && HEX64.test(r.stdout_sha256 as string),
    );
    need(
      "stderr_sha256",
      typeof r.stderr_sha256 === "string" && HEX64.test(r.stderr_sha256 as string),
    );
    need("runs", r.runs === undefined);
    need("env", r.env === undefined);
    need("signature", r.signature === undefined && r.signer === undefined);
  } else {
    need("exit_code", r.exit_code === undefined);
    need("duration_ms", r.duration_ms === undefined);
    need("stdout_sha256", r.stdout_sha256 === undefined);
    need("stderr_sha256", r.stderr_sha256 === undefined);
    const runs = r.runs;
    need(
      "runs",
      Array.isArray(runs) &&
        runs.length >= 1 &&
        runs.every(
          (run) =>
            typeof run === "object" &&
            run !== null &&
            typeof (run as OracleRun).exit_code === "number" &&
            typeof (run as OracleRun).duration_ms === "number" &&
            (run as OracleRun).duration_ms >= 0 &&
            HEX64.test(String((run as OracleRun).stdout_sha256)) &&
            HEX64.test(String((run as OracleRun).stderr_sha256)),
        ),
    );
    const env = r.env as ReceiptEnv | undefined;
    need(
      "env",
      !!env &&
        typeof env === "object" &&
        typeof env.os === "string" &&
        env.os !== "" &&
        typeof env.arch === "string" &&
        env.arch !== "" &&
        (env.runtime === "bun" || env.runtime === "node") &&
        typeof env.runtime_version === "string" &&
        env.runtime_version !== "" &&
        typeof env.dirty_tree === "boolean",
    );
    need(
      "signature",
      (r.signature === undefined && r.signer === undefined) ||
        (typeof r.signature === "string" &&
          r.signature !== "" &&
          typeof r.signer === "string" &&
          r.signer !== ""),
    );
  }
  need("task_id", typeof r.task_id === "string" && r.task_id !== "");
  need("seq", typeof r.seq === "number" && Number.isInteger(r.seq) && (r.seq as number) >= 1);
  need(
    "prev",
    r.prev === "genesis" || (typeof r.prev === "string" && HEX64.test(r.prev as string)),
  );
  need("harness", typeof r.harness === "string" && r.harness !== "");
  need("model", r.model === null || typeof r.model === "string");
  need("plugin_version", typeof r.plugin_version === "string");
  const o = r.oracle as Record<string, unknown> | undefined;
  need(
    "oracle",
    !!o && typeof o === "object" && typeof o.run === "string" && typeof o.expect === "string",
  );
  need("base_sha", typeof r.base_sha === "string" && HEX40.test(r.base_sha as string));
  need("tree_sha", typeof r.tree_sha === "string" && HEX40.test(r.tree_sha as string));
  need("verdict", r.verdict === "pass");
  need(
    "verified_at",
    typeof r.verified_at === "string" && !Number.isNaN(Date.parse(r.verified_at as string)),
  );
  return errors;
}

function readReceiptRawFrom(dir: string, id: string): Buffer | null {
  try {
    return readFileSync(receiptPath(dir, id));
  } catch {
    return null;
  }
}

function readReceiptRawFromRef(cwd: string, ref: string, id: string): Buffer | null {
  const r = spawnSync("git", ["show", `${ref}:.sddx/receipts/${id}.json`], { cwd });
  return r.status === 0 ? (r.stdout as Buffer) : null;
}

/**
 * Resolves a task's receipt bytes wherever they currently live: a live
 * worktree, the main checkout, the tip of the task's own branch (once its
 * worktree has been swept), or — if that branch has been deleted after the
 * task merged into a goal's run branch (`cleanup` allows this once a task is
 * merged, whether or not it's shipped yet) — the run branch's own tree, which
 * still carries the same receipt via that merge.
 */
export function resolveReceiptRaw(cwd: string, id: string): Buffer | null {
  const direct =
    readReceiptRawFrom(join(cwd, ".sddx-worktrees", id), id) ??
    readReceiptRawFrom(cwd, id) ??
    readReceiptRawFromRef(cwd, `sddx/${id}`, id);
  if (direct) return direct;
  const goal = findGoalForTask(cwd, id);
  return goal ? readReceiptRawFromRef(cwd, goal.run_branch, id) : null;
}

/**
 * Where a task's receipt can be read from, named the way a human would open it
 * — a filesystem path, or a `<ref>:<path>` git spec when the receipt survives
 * only inside a branch. Null when there is none.
 *
 * The run summary quotes this so a reported `pass` is something the reader can
 * open. A verdict nobody can check is the kind of claim receipts exist to
 * replace.
 */
export function resolveReceiptPath(cwd: string, id: string): string | null {
  const wt = join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`);
  if (existsSync(wt)) return wt;
  const local = join(cwd, ".sddx", "receipts", `${id}.json`);
  if (existsSync(local)) return local;
  if (readReceiptRawFromRef(cwd, `sddx/${id}`, id)) {
    return `sddx/${id}:.sddx/receipts/${id}.json`;
  }
  const goal = findGoalForTask(cwd, id);
  if (goal && readReceiptRawFromRef(cwd, goal.run_branch, id)) {
    return `${goal.run_branch}:.sddx/receipts/${id}.json`;
  }
  return null;
}

/** Same cross-location lookup as `resolveReceiptRaw`, parsed. */
export function resolveReceipt(cwd: string, id: string): Receipt | null {
  const raw = resolveReceiptRaw(cwd, id);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8")) as Receipt;
  } catch {
    return null;
  }
}

/**
 * Receipts form a hash tree rooted at "genesis": parallel worktrees legitimately
 * write siblings sharing one parent, so validation requires every `prev` to match
 * the file hash of a receipt with strictly smaller `seq` — the linear chain is the
 * sequential special case. Tampering with any parent orphans its children loudly.
 */
export function verifyChain(cwd: string): string[] {
  const errors: string[] = [];
  const receipts = listReceipts(cwd);
  const seqByHash = new Map<string, number>();
  for (const { file, receipt } of receipts) {
    seqByHash.set(sha256(readFileSync(file)), receipt.seq);
  }
  for (const { file, receipt } of receipts) {
    for (const e of validateReceipt(receipt)) errors.push(`${file}: ${e}`);
    if (receipt.prev === "genesis") {
      if (receipt.seq !== 1) {
        errors.push(`${file}: genesis-linked receipt must have seq 1, got ${receipt.seq}`);
      }
      continue;
    }
    const parentSeq = seqByHash.get(receipt.prev);
    if (parentSeq === undefined) {
      errors.push(`${file}: prev hash matches no receipt — chain broken (tampered or deleted)`);
    } else if (parentSeq >= receipt.seq) {
      errors.push(`${file}: seq ${receipt.seq} must exceed parent seq ${parentSeq}`);
    }
  }
  return errors;
}
