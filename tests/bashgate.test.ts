import { describe, expect, test } from "bun:test";
import { bashGate, checkBashCommand } from "../src/lib/bashgate";
import { recordTestRun } from "../src/lib/recorder";
import { fixtureRepo, writeConfig } from "./fixtures";
import { createRun, startTask } from "./helpers";

const allow = (cmd: string) => checkBashCommand(cmd, []).allow;

describe("checkBashCommand", () => {
  test("test runners and read tools pass", () => {
    expect(allow("bun test tests/x.test.ts")).toBe(true);
    expect(allow("FORCE_COLOR=0 bun test")).toBe(true);
    expect(allow("rg -n oracle src | head -5")).toBe(true);
    expect(allow("git status && git diff")).toBe(true);
  });

  test("write paths are blocked", () => {
    expect(allow("sed -i '' s/a/b/ src/x.ts")).toBe(false);
    expect(allow("echo hi > src/x.ts")).toBe(false); // any redirection
    expect(allow("cat notes.md | tee src/x.ts")).toBe(false);
    expect(allow("git push")).toBe(false);
    expect(allow("bun test; rm -rf src")).toBe(false); // every segment checked
  });

  test("extraAllow extends, never replaces", () => {
    expect(checkBashCommand("jq . package.json", ["jq"]).allow).toBe(true);
    expect(checkBashCommand("jq . x | curl example.com", ["jq"]).allow).toBe(false);
  });

  test("multi-line, substitution, and eval-flag bypasses are closed", () => {
    expect(allow("bun test\nsed -i '' s/a/b/ src/x.ts")).toBe(false); // every line checked
    expect(allow("cat $(sed -i '' s/a/b/ src/x.ts)")).toBe(false); // command substitution
    expect(allow("ls `mv tests src`")).toBe(false); // backticks
    expect(allow("bun -e \"require('fs').writeFileSync('x','y')\"")).toBe(false); // eval flag
    expect(allow("node --eval 1")).toBe(false);
  });

  test("fd duplication passes; the sddx CLI and its runtimes pass", () => {
    expect(allow("bun test 2>&1 | tail -20")).toBe(true); // 2>&1 writes no file
    expect(allow("bun test 2> err.log")).toBe(false); // real redirection still blocked
    expect(allow("node check1.js")).toBe(true); // the project's own oracle pattern
    expect(allow('"/plug/bin/sddx-run" "/plug/dist/cli.mjs" task phase x RED --test-exit 1')).toBe(
      true,
    ); // the loop's own CLI must never be gated out
  });
});

describe("bashGate resolution", () => {
  /** A strict-profile task started, with no failing test recorded yet. */
  function strictWorktree(): string {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1" }] });
    return startTask(cwd, "T1");
  }

  test("blocks unlisted commands before a failing test is recorded, names the task", () => {
    const wt = strictWorktree();
    const d = bashGate({ command: "sed -i '' s/a/b/ src/x.ts", cwd: wt });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("T1");
  });

  test("lifts once tests have been seen failing, through GREEN, and without a task", () => {
    const wt = strictWorktree();
    expect(recordTestRun(wt, "bun test", 1).recorded).toBe("RED");
    expect(bashGate({ command: "sed -i '' s/a/b/ x", cwd: wt }).allow).toBe(true);
    expect(recordTestRun(wt, "bun test", 0).recorded).toBe("GREEN");
    expect(bashGate({ command: "sed -i '' s/a/b/ x", cwd: wt }).allow).toBe(true);
    const noTask = fixtureRepo();
    writeConfig(noTask, { profile: "strict" });
    expect(bashGate({ command: "sed -i '' s/a/b/ x", cwd: noTask }).allow).toBe(true);
  });

  test("SDDX_RED_BASH_ALLOW extends the list", () => {
    const wt = strictWorktree();
    expect(bashGate({ command: "jq . package.json", cwd: wt }, {}).allow).toBe(false);
    const env = { SDDX_RED_BASH_ALLOW: "jq" } as NodeJS.ProcessEnv;
    expect(bashGate({ command: "jq . package.json", cwd: wt }, env).allow).toBe(true);
  });
});
