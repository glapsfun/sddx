// The transcript readers return the commands an agent ran and its final reply,
// and refuse anything that is not a transcript of the expected shape. The
// samples are stripped excerpts of real sessions from the first live run.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readClaudeTranscript,
  readCodexTranscript,
  runsSddx,
  unwrapShell,
} from "../evals/transcript";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

const sample = (name: string) =>
  readFileSync(join(repoRoot, "tests", "fixtures", "evals", name), "utf8");

describe("transcript readers", () => {
  scenario("behavior-evals", "Claude Code transcript", () => {
    const t = readClaudeTranscript(sample("claude-code.jsonl"));
    expect(t.commands.map((c) => c.failed)).toEqual([true, true, false, false]);
    expect(t.commands[0]?.command).toEndWith("echo ---; sddx migrate 2>&1");
    expect(t.commands[3]?.command).toStartWith("cd <fixture>/.sddx-worktrees/");
    expect(t.reply).toStartWith("This repo is still on sddx 5 and half-finished");
    expect(t.model).toBe("claude-opus-5-5");
    expect(t.tokens).toEqual({ input: 137853, output: 2117 });
  });

  scenario("behavior-evals", "Codex transcript", () => {
    const t = readCodexTranscript(sample("codex.jsonl"));
    expect(t.commands.map((c) => c.exit)).toEqual([0, 1, 1, 0, 0]);
    expect(t.commands[2]).toEqual({
      command: "~/plugins/cache/sddx/sddx/5.0.0/bin/sddx migrate",
      exit: 1,
      failed: true,
    });
    expect(t.commands.every((c) => !/^\S*sh -l?c /.test(c.command))).toBe(true);
    expect(t.reply).toStartWith("This repo is still on **sddx 5**");
    expect(t.tokens).toEqual({ input: 66659, output: 611 });
  });

  test("a shell wrapper is undone, quotes and all", () => {
    expect(unwrapShell(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(unwrapShell(`zsh -c "echo \\"hi\\" \\$HOME"`)).toBe('echo "hi" $HOME');
    expect(unwrapShell("sddx board")).toBe("sddx board");
  });

  test("anything that is not a transcript throws", () => {
    expect(() => readClaudeTranscript("not json\n")).toThrow("not JSON");
    expect(() => readClaudeTranscript('{"type":"system","subtype":"init"}\n')).toThrow("no result");
    expect(() => readCodexTranscript("")).toThrow("no thread");
    expect(() =>
      readCodexTranscript('{"type":"turn.failed","error":{"message":"quota"}}\n'),
    ).toThrow("quota");
  });

  test("a command runs sddx by name or by path, not by mention", () => {
    for (const c of [
      "sddx board",
      "cd x && sddx verify a",
      "/p/bin/sddx plan check s",
      "'sddx' x",
    ]) {
      expect(runsSddx(c)).toBe(true);
    }
    for (const c of ["ls .sddx/specs", "sddx-run x", "cat sddx.md", "echo xsddx y"]) {
      expect(runsSddx(c)).toBe(false);
    }
  });
});
