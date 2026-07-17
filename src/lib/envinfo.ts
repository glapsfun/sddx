// Environment evidence for receipts: what ran the oracle, where, and whether the
// tree carried uncommitted changes. Pure capture — no judgment.
import { spawnSync } from "node:child_process";
import { arch, platform } from "node:os";
import type { ReceiptEnv } from "./receipt";

export function captureEnv(cwd: string): ReceiptEnv {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return {
    os: platform(),
    arch: arch(),
    runtime: bun ? "bun" : "node",
    runtime_version: bun ? bun.version : process.versions.node,
    dirty_tree: status.status === 0 && (status.stdout ?? "").trim() !== "",
  };
}
