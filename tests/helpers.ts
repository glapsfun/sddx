import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
