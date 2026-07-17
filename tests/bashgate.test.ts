import { describe, expect, test } from "bun:test";
import { bashGate, checkBashCommand } from "../src/lib/bashgate";
import { headSha } from "../src/lib/git";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";
import { fixtureRepo } from "./fixtures";

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
});

describe("bashGate resolution", () => {
  function repoInRed() {
    const cwd = fixtureRepo();
    const spec = parseSpec(
      "task: gate fixture\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: x\n",
    ).spec!;
    let t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: headSha(cwd) });
    t = transition(t, "RED", { testExit: 1 });
    writeTask(cwd, t);
    return { cwd, t };
  }

  test("blocks unlisted commands pre-GREEN, names the task", () => {
    const { cwd, t } = repoInRed();
    const d = bashGate({ command: "sed -i '' s/a/b/ src/x.ts", cwd });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain(t.id);
  });

  test("lifts after GREEN and without a task", () => {
    const { cwd, t } = repoInRed();
    let task = { ...t };
    task = transition(task, "GREEN", { testExit: 0 });
    writeTask(cwd, task);
    expect(bashGate({ command: "sed -i '' s/a/b/ x", cwd }).allow).toBe(true);
    expect(bashGate({ command: "sed -i '' s/a/b/ x", cwd: fixtureRepo() }).allow).toBe(true);
  });

  test("SDDX_RED_BASH_ALLOW extends the list", () => {
    const { cwd } = repoInRed();
    const env = { SDDX_RED_BASH_ALLOW: "jq" } as NodeJS.ProcessEnv;
    expect(bashGate({ command: "jq . package.json", cwd }, env).allow).toBe(true);
  });
});
