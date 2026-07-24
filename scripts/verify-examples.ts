// Replays every examples/NN-*/README.md's ```sh fenced blocks against a
// scratch git repo, so a documented command that stops working is a test
// failure, not silent doc rot. dist/cli.mjs is committed to the repo, so no
// build step is needed here — the harness runs the same bundle a real
// install would run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Block {
  code: string;
  expectExit: number;
}

export interface ExampleResult {
  name: string;
  ok: boolean;
  message: string;
}

const FENCE_RE = /```sh(?:[ \t]+(skip|expect=\d+))?\n([\s\S]*?)```/g;

export function parseReadmeBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = FENCE_RE.exec(markdown);
  while (m !== null) {
    const modifier = m[1];
    const code = m[2] ?? "";
    if (modifier !== "skip") {
      const expectExit = modifier?.startsWith("expect=") ? Number(modifier.slice(7)) : 0;
      blocks.push({ code, expectExit });
    }
    m = FENCE_RE.exec(markdown);
  }
  return blocks;
}

/** Each block becomes a bash function so `cd`/exported vars persist into the
 * next block (bash functions run in the caller's shell, not a subshell) —
 * required for a walkthrough that captures a task id in one step and reuses
 * it several steps later, exactly like a human running the same commands. */
export function buildScript(blocks: Block[]): string {
  const parts = ["set -u"];
  blocks.forEach((b, i) => {
    parts.push(
      `__block_${i}() {`,
      b.code,
      "}",
      `__block_${i}`,
      `__actual_${i}=$?`,
      `if [ "$__actual_${i}" -ne "${b.expectExit}" ]; then echo "block ${i + 1}: expected exit ${b.expectExit}, got $__actual_${i}" >&2; exit 1; fi`,
    );
  });
  return parts.join("\n");
}

export function discoverExamples(repoRoot: string): string[] {
  const dir = join(repoRoot, "examples");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "README.md")))
    .sort();
}

export function runExample(repoRoot: string, name: string, targetDir: string): ExampleResult {
  const exampleDir = join(repoRoot, "examples", name);
  const readmePath = join(exampleDir, "README.md");
  if (!existsSync(readmePath)) {
    return { name, ok: false, message: `no such example: ${exampleDir}` };
  }
  const blocks = parseReadmeBlocks(readFileSync(readmePath, "utf8"));
  if (blocks.length === 0) {
    return { name, ok: false, message: "no executable ```sh blocks found in README.md" };
  }
  const setupPath = join(exampleDir, "setup.sh");
  if (existsSync(setupPath)) {
    const s = spawnSync("bash", [setupPath, targetDir], { cwd: exampleDir, encoding: "utf8" });
    if (s.status !== 0) {
      return { name, ok: false, message: `setup.sh failed: ${s.stderr || s.stdout}` };
    }
  }
  const r = spawnSync("bash", ["-c", buildScript(blocks)], { cwd: targetDir, encoding: "utf8" });
  if (r.status !== 0) {
    return { name, ok: false, message: r.stderr || r.stdout || `exit ${r.status}` };
  }
  return { name, ok: true, message: "" };
}

if (import.meta.main) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const names = discoverExamples(repoRoot);
  let failed = 0;
  for (const name of names) {
    const target = mkdtempSync(join(tmpdir(), `sddx-example-${name}-`));
    const result = runExample(repoRoot, name, target);
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${name}`);
    if (!result.ok) {
      failed += 1;
      console.error(result.message);
    }
  }
  console.log(`${names.length - failed}/${names.length} examples passed`);
  process.exit(failed === 0 ? 0 : 1);
}
