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
    // The launcher refuses to start without Bun, so the absent-Bun branch is
    // unreachable in a supported install. It records `unknown` rather than
    // naming whatever else is executing, because a receipt must not read as
    // evidence that a second runtime is supported.
    runtime: bun ? "bun" : "unknown",
    runtime_version: bun ? bun.version : "unknown",
    dirty_tree: status.status === 0 && (status.stdout ?? "").trim() !== "",
  };
}
