import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScript,
  discoverExamples,
  parseReadmeBlocks,
  runExample,
} from "../scripts/verify-examples";

describe("parseReadmeBlocks", () => {
  test("extracts sh fenced blocks with default exit 0", () => {
    const md = "prose\n\n```sh\necho hi\n```\n\nmore prose\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "echo hi\n", expectExit: 0 }]);
  });

  test("reads an expect= marker for a non-zero exit", () => {
    const md = "```sh expect=1\nexit 1\n```\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "exit 1\n", expectExit: 1 }]);
  });

  test("ignores non-sh fenced blocks", () => {
    const md = "```yaml\ntask: x\n```\n```sh\necho hi\n```\n";
    expect(parseReadmeBlocks(md)).toHaveLength(1);
  });

  test("skip-marked blocks are parsed but excluded from execution", () => {
    const md = "```sh skip\nsddx pr create --goal g\n```\n```sh\necho hi\n```\n";
    expect(parseReadmeBlocks(md)).toEqual([{ code: "echo hi\n", expectExit: 0 }]);
  });
});

describe("buildScript", () => {
  test("wraps each block and asserts its expected exit code", () => {
    // (exit 3) — a subshell — not a bare `exit 3`: a bare `exit` inside a
    // bash function terminates the whole script, not just the function,
    // since functions share the caller's shell (this is exactly why real
    // example blocks never call `exit` directly — only subprocesses like
    // `sddx`/`git`/`bun` do, and their exit never touches the wrapping shell).
    const script = buildScript([{ code: "(exit 3)\n", expectExit: 3 }]);
    const r = Bun.spawnSync(["bash", "-c", script]);
    expect(r.exitCode).toBe(0);
  });

  test("fails loudly when a block's exit code doesn't match", () => {
    const script = buildScript([{ code: "(exit 0)\n", expectExit: 1 }]);
    const r = Bun.spawnSync(["bash", "-c", script]);
    expect(r.exitCode).toBe(1);
    expect(new TextDecoder().decode(r.stderr)).toContain("expected exit 1, got 0");
  });

  test("later blocks see state (cwd, variables) set by earlier ones", () => {
    const script = buildScript([
      { code: "mkdir sub && cd sub && export X=hi\n", expectExit: 0 },
      { code: '[ "$(basename "$PWD")" = sub ] && [ "$X" = hi ]\n', expectExit: 0 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "sddx-buildscript-"));
    const r = Bun.spawnSync(["bash", "-c", script], { cwd: dir });
    expect(r.exitCode).toBe(0);
  });
});

describe("discoverExamples", () => {
  test("lists example directories that carry a README.md, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-discover-"));
    mkdirSync(join(root, "examples", "02-b"), { recursive: true });
    mkdirSync(join(root, "examples", "01-a"), { recursive: true });
    writeFileSync(join(root, "examples", "02-b", "README.md"), "# b\n");
    writeFileSync(join(root, "examples", "01-a", "README.md"), "# a\n");
    mkdirSync(join(root, "examples", "not-an-example"), { recursive: true });
    expect(discoverExamples(root)).toEqual(["01-a", "02-b"]);
  });

  test("returns an empty list when examples/ doesn't exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-noexamples-"));
    expect(discoverExamples(root)).toEqual([]);
  });
});

describe("runExample", () => {
  function fixtureExample(root: string, name: string, readme: string, setup?: string): void {
    const dir = join(root, "examples", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), readme);
    if (setup) {
      const setupPath = join(dir, "setup.sh");
      writeFileSync(setupPath, setup);
      chmodSync(setupPath, 0o755);
    }
  }

  test("passes when every documented command exits as expected", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runok-"));
    fixtureExample(
      root,
      "01-ok",
      "```sh\necho hello > out.txt\n```\n```sh\ntest -f out.txt\n```\n",
    );
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "01-ok", target);
    expect(result.ok).toBe(true);
  });

  test("fails when a documented command's exit code doesn't match its marker", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runbad-"));
    fixtureExample(root, "02-bad", "```sh\ntest -f nonexistent.txt\n```\n");
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "02-bad", target);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected exit 0");
  });

  test("runs setup.sh with the target directory before replaying blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-runsetup-"));
    fixtureExample(
      root,
      "03-setup",
      "```sh\ntest -f marker.txt\n```\n",
      '#!/bin/sh\ntouch "$1/marker.txt"\n',
    );
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "03-setup", target);
    expect(result.ok).toBe(true);
  });

  test("a missing example directory fails rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "sddx-missing-"));
    const target = mkdtempSync(join(tmpdir(), "sddx-target-"));
    const result = runExample(root, "99-nope", target);
    expect(result.ok).toBe(false);
  });
});
