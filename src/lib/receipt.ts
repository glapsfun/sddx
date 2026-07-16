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

export interface Receipt {
  version: 1;
  task_id: string;
  seq: number;
  prev: string;
  harness: string;
  model: string | null;
  plugin_version: string;
  oracle: { run: string; expect: string };
  exit_code: number;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  base_sha: string;
  tree_sha: string;
  verdict: "pass";
  verified_at: string;
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
  need("version", r.version === 1);
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
  need("base_sha", typeof r.base_sha === "string" && HEX40.test(r.base_sha as string));
  need("tree_sha", typeof r.tree_sha === "string" && HEX40.test(r.tree_sha as string));
  need("verdict", r.verdict === "pass");
  need(
    "verified_at",
    typeof r.verified_at === "string" && !Number.isNaN(Date.parse(r.verified_at as string)),
  );
  return errors;
}

export function verifyChain(cwd: string): string[] {
  const errors: string[] = [];
  const receipts = listReceipts(cwd);
  let prevFileHash = "genesis";
  receipts.forEach(({ file, receipt }, i) => {
    for (const e of validateReceipt(receipt)) errors.push(`${file}: ${e}`);
    if (receipt.seq !== i + 1) {
      errors.push(`${file}: seq ${receipt.seq}, expected ${i + 1} (gap or duplicate)`);
    }
    if (receipt.prev !== prevFileHash) {
      errors.push(`${file}: prev hash mismatch — chain broken (tampered or deleted receipt)`);
    }
    prevFileHash = sha256(readFileSync(file));
  });
  return errors;
}
