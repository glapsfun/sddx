import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = new URL("..", import.meta.url).pathname;

/** Inject oracle_red evidence dated 1970 — satisfies verify's red-check gate in
 * fixtures whose oracles pass from the start. Real red-checks are e2e-tested. */
export function fakeRedCheck(root: string, id: string): void {
  const path = join(root, ".sddx", "tasks", `${id}.json`);
  const t = JSON.parse(readFileSync(path, "utf8"));
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
}

export async function runsCleanly(cmd: string[], env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await new Response(proc.stderr).text()).toBe("");
}

/**
 * Goal ids visible to sddx, wherever their records live.
 *
 * A canonical run commits its goal record to `sddx/run-<goal-id>`, so counting
 * files in the main checkout's `.sddx/goals/` no longer answers "did a goal get
 * created". Legacy loose records are still counted, since they are still read.
 */
export function goalIds(cwd: string): string[] {
  const ids = new Set<string>();
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  const branches = spawnSync(
    "git",
    ["branch", "--list", "sddx/run-*", "--format=%(refname:short)"],
    { cwd, encoding: "utf8" },
  );
  for (const b of (branches.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (!b.startsWith("sddx/run-")) continue;
    const id = b.slice("sddx/run-".length);
    // A bare run branch is not a goal. Preflight tests plant one to force a
    // collision, and counting it would report a goal that was never created.
    const has = spawnSync("git", ["cat-file", "-e", `${b}:.sddx/goals/${id}.json`], { cwd });
    if (has.status === 0) ids.add(id);
  }
  return [...ids].sort();
}

/** A goal record, read from wherever it lives. */
export function readGoalAnywhere(cwd: string, id: string): Record<string, unknown> {
  const loose = join(cwd, ".sddx", "goals", `${id}.json`);
  if (existsSync(loose)) return JSON.parse(readFileSync(loose, "utf8"));
  const r = spawnSync("git", ["show", `sddx/run-${id}:.sddx/goals/${id}.json`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`no goal ${id} in ${cwd}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
