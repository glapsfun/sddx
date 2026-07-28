import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = new URL("..", import.meta.url).pathname;

/** The Goal Brief header keys every *planned* graph must carry. Intake writes
 * the header; the orchestrator appends `tasks:`. Fixtures that hand-write a
 * plan prepend this so they describe a plan rather than a half-written draft.
 * The optional list keys (answers, assumptions, …) are omitted on purpose —
 * this is the minimum a graph needs to parse. */
export const GRAPH_HEADER_LINES = ['schema_version: "1.0"', "interaction_mode: human"];
export const GRAPH_HEADER = `${GRAPH_HEADER_LINES.join("\n")}\n`;

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
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  for (const r of (refs.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (r.startsWith("refs/sddx/goals/")) ids.add(r.slice("refs/sddx/goals/".length));
  }
  return [...ids].sort();
}

/** A goal record, read from wherever it lives. */
export function readGoalAnywhere(cwd: string, id: string): Record<string, unknown> {
  const r = spawnSync("git", ["cat-file", "-p", `refs/sddx/goals/${id}`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status === 0) return JSON.parse(r.stdout);
  const loose = join(cwd, ".sddx", "goals", `${id}.json`);
  if (existsSync(loose)) return JSON.parse(readFileSync(loose, "utf8"));
  throw new Error(`no goal ${id} in ${cwd}: ${r.stderr}`);
}

/** Rewrites a goal record wherever it lives — for tests that tamper with it. */
export function mutateGoal(cwd: string, mutate: (g: Record<string, unknown>) => void): void {
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"], {
    cwd,
    encoding: "utf8",
  });
  const ids = (refs.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((r) => r.startsWith("refs/sddx/goals/"))
    .map((r) => r.slice("refs/sddx/goals/".length));
  for (const id of ids) {
    const g = readGoalAnywhere(cwd, id);
    mutate(g);
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd,
      input: `${JSON.stringify(g, null, 2)}\n`,
      encoding: "utf8",
    });
    spawnSync("git", ["update-ref", `refs/sddx/goals/${id}`, (blob.stdout ?? "").trim()], { cwd });
  }
  const dir = join(cwd, ".sddx", "goals");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const p = join(dir, f);
      const g = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      mutate(g);
      writeFileSync(p, `${JSON.stringify(g, null, 2)}\n`);
    }
  }
}
