// Regressions for ways the plan-approval gate could be walked around without a
// human ever seeing the dialog. Each test here corresponds to a working bypass:
// the gate reported itself satisfied while nobody had approved anything.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decideGate, SELF_MODIFYING_GLOBS } from "../src/lib/approval";
import { approvalGate, gatedAction, lex } from "../src/lib/approvalgate";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { fixtureRepo } from "./fixtures";
import { goalSpec, writeSpec } from "./helpers";

describe("gatedAction sees through shell syntax", () => {
  test("a `#` inside a quoted argument does not hide the rest of the line", () => {
    // The comment strip ran to end-of-string with no quote awareness, so
    // everything after the `#` in the commit message vanished from the gate's
    // view, including the approve, which then ran with no dialog.
    expect(gatedAction('git commit -m "fix #12" && sddx plan approve plan.md')).toBe("approve");
    expect(gatedAction("git commit -m 'see #9' ; sddx plan start plan.md")).toBe("start");
  });

  test("a real comment is still a comment", () => {
    expect(gatedAction("bun test # sddx plan approve plan.md")).toBe(null);
    expect(gatedAction("# sddx plan start plan.md")).toBe(null);
  });

  test("quoted subcommands still match", () => {
    for (const cmd of [
      'sddx plan "approve" plan.md',
      "sddx plan 'approve' plan.md",
      'sddx "plan" approve plan.md',
    ]) {
      expect(gatedAction(cmd)).toBe("approve");
    }
    expect(gatedAction('sddx "plan" start plan.md')).toBe("start");
  });

  test("every spelling of an sddx invocation is gated", () => {
    // `plan` alone is a common word, so the gate only fires behind an sddx
    // invocation. That narrowing must not drop the ways sddx is actually run.
    for (const cmd of [
      "bunx sddx plan approve plan.md",
      "/usr/local/bin/sddx plan approve plan.md",
      "./bin/sddx-run plan approve plan.md",
      "bun src/cli.ts plan approve plan.md",
      "node dist/cli.mjs plan approve plan.md",
      "SDDX_HARNESS=x sddx plan approve plan.md",
      // package specs, scoped and versioned: these walked past the gate when
      // the matcher compared the whole basename against a fixed list
      "npx -y @glapsfun/sddx@6.0.0 plan approve plan.md",
      "bunx @glapsfun/sddx@latest plan approve plan.md",
      "npx sddx@6 plan approve plan.md",
      "npm exec --offline --no -- @glapsfun/sddx plan approve plan.md",
      "/opt/tools/sddx-6.0.0/bin/run plan approve plan.md",
    ]) {
      expect(gatedAction(cmd)).toBe("approve");
    }
  });

  test("the package-spec spellings raise the dialog through the real hook", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "npx -y @glapsfun/sddx@6.0.0 plan approve .sddx/specs/2026-01-01-x.md",
      "bunx @glapsfun/sddx@latest plan start .sddx/specs/2026-01-01-x.md",
    ]) {
      expect(approvalGate({ command, cwd }).decision).toBe("ask");
    }
  });

  test("a plan subcommand of an unrelated tool is not gated", () => {
    expect(gatedAction("terraform plan start")).toBe(null);
    expect(gatedAction("make plan approve")).toBe(null);
  });

  test("a line continuation is spliced, not treated as a segment break", () => {
    // The shell runs this as one command; splitting on the raw newline left
    // `plan` and `approve` in different segments, so neither matched.
    expect(gatedAction("sddx plan \\\napprove plan.md")).toBe("approve");
    expect(gatedAction("sddx plan \\\nstart plan.md")).toBe("start");
  });

  test("`plan check` is exempt, per segment", () => {
    expect(gatedAction("sddx plan check plan.md")).toBe(null);
    // ...but a check in one segment must not vouch for a real start in another
    expect(gatedAction("sddx plan check p.md && sddx plan start p.md")).toBe("start");
  });

  test("a wrapper does not hide the command inside one token", () => {
    // Quote-aware lexing is what makes `'sddx plan approve …'` a single token;
    // the naive splitter this replaced caught these only by accident, because it
    // never stripped quotes. Losing them would reintroduce a no-dialog approval.
    for (const cmd of [
      "sh -c 'sddx plan approve p.md'",
      'bash -c "sddx plan approve p.md"',
      "eval 'sddx plan approve p.md'",
      `sh -c "sh -c 'sddx plan approve p.md'"`,
    ]) {
      expect(gatedAction(cmd)).toBe("approve");
    }
    expect(gatedAction("sh -c 'sddx plan start p.md'")).toBe("start");
    expect(gatedAction("sh -c 'sddx plan check p.md'")).toBe(null);
  });

  test("approve wins over start wherever it appears in the line", () => {
    // Per-segment ordering returned on the first match, so a gate-satisfiable
    // start in an earlier segment reported the whole line as a start, and the
    // approve then ran with no dialog, minting a token for an arbitrary plan.
    expect(gatedAction("sddx plan start good.md && sddx plan approve evil.md")).toBe("approve");
    expect(gatedAction("sddx plan start good.md ; sddx plan approve evil.md")).toBe("approve");
    expect(gatedAction("sddx plan check a.md && sh -c 'sddx plan approve b.md'")).toBe("approve");
  });

  test("quoting the phrase is not a gated action", () => {
    // Recursion is limited to wrapper commands. Unwrapping every token that
    // contained whitespace made a commit message raise an approval dialog, and a
    // dialog that cries wolf trains the user to click through the one prompt the
    // design rests on.
    expect(gatedAction('git commit -m "run sddx plan approve first"')).toBe(null);
    expect(gatedAction('rg "plan approve" src/')).toBe(null);
    expect(gatedAction('echo "remember: sddx plan start p.md"')).toBe(null);
  });

  test("global flags between the subcommand pair do not hide it", () => {
    // parseOutputFlag strips --output/--no-color from ANY position before
    // dispatch, so `plan --output json approve` really does run plan approve.
    expect(gatedAction("sddx plan --output json approve p.md")).toBe("approve");
    expect(gatedAction("sddx plan --no-color approve p.md")).toBe("approve");
    expect(gatedAction("sddx plan --output json start p.md")).toBe("start");
    // a different subcommand still is not a match
    expect(gatedAction("sddx plan show approve")).toBe(null);
  });

  test("lex reports every expansion as opaque, not just substitution", () => {
    for (const cmd of [
      "sddx plan approve $(ls .sddx/specs/*.md)",
      "`sddx plan approve`",
      'sddx plan approve "$(cat f)"',
      "sddx plan $'approve' p.md",
      "A=approve; sddx plan $A p.md",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test
      "sddx plan ${SUB} p.md",
    ]) {
      expect(lex(cmd).opaque).toBe(true);
    }
    expect(lex("sddx plan approve plan.md").opaque).toBe(false);
    // `$` inside single quotes is literal to the shell, so it is not an expansion
    expect(lex("echo 'costs $5'").opaque).toBe(false);
    // an unterminated quote means the parse does not describe what will run
    expect(lex('sddx plan approve "plan.md').opaque).toBe(true);
  });

  test("an opaque line naming sddx AND plan asks rather than passing", () => {
    const cwd = fixtureRepo();
    expect(approvalGate({ command: "A=approve; sddx plan $A p.md", cwd }).decision).toBe("ask");
    // Scoped to both words. Requiring only `sddx` asked on every command using a
    // variable near a path containing "sddx", including plain reads, on the hot
    // path for all Bash.
    for (const command of [
      "cd $HOME/dev/github/glapsfun/sddx && bun test",
      "sddx task show $ID",
      "echo $HOME/sddx",
      "echo $(date)",
    ]) {
      expect(approvalGate({ command, cwd }).decision).toBe("pass");
    }
  });
});

describe("approval trust inputs are unreachable from Bash", () => {
  test("a redirect into .sddx/approvals/ is refused with no task in play", () => {
    const cwd = fixtureRepo();
    // No task resolves at repo root, which is exactly the state a plan sits in
    // while awaiting approval, so this shell write forged a token with nothing
    // looking.
    const d = approvalGate({ command: `printf '{}' > .sddx/approvals/deadbeef.json`, cwd });
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain(".sddx/approvals/");
  });

  test("writing to the token directory by any spelling is refused", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "mkdir -p .sddx/approvals && echo x > .sddx/approvals/a.json",
      "cp /tmp/a.json .sddx/tasks/../approvals/a.json",
      "tee .sddx/approvals/a.json",
      // The strict profile's allow-list exists to permit test runs, so it admits
      // every one of these; using it as a read-only proxy reopened the forge path.
      "find .sddx/approvals -name '*.json' -delete",
      "find .sddx/approvals -type d -exec cp /tmp/forged.json {}/a.json ;",
      "bun run /tmp/forge.ts .sddx/approvals/a.json",
      "node /tmp/forge.js .sddx/approvals/a.json",
      "python3 /tmp/forge.py .sddx/approvals/a.json",
      "make forge FILE=.sddx/approvals/a.json",
    ]) {
      expect(approvalGate({ command, cwd }).decision, command).toBe("deny");
    }
  });

  test(".sddx/config.json is refused too; it decides whether the gate arms", () => {
    const cwd = fixtureRepo();
    for (const command of [
      `echo '{"interaction_mode":"auto"}' > .sddx/config.json`,
      // redirect glued to the filename: anchoring on an explicit character class
      // dropped this spelling, which is exactly the write being guarded
      `cd .sddx;printf '{"interaction_mode":"auto"}'>config.json`,
      "node /tmp/forge.js .sddx/config.json",
    ]) {
      const d = approvalGate({ command, cwd });
      expect(d.decision, command).toBe("deny");
      expect(d.reason).toContain("interaction_mode");
    }
  });

  test("reads of those paths are NOT blocked", () => {
    // A token is not a secret, and this repo's own source and tests reference
    // these paths constantly; refusing to grep them would make ordinary work
    // here impossible.
    const cwd = fixtureRepo();
    for (const command of [
      "grep -rn '.sddx/approvals' src/",
      "rg approvals .sddx",
      "cat .sddx/approvals/a.json",
      "ls .sddx/config.json",
      "git diff .sddx/config.json",
    ]) {
      expect(approvalGate({ command, cwd }).decision, command).toBe("pass");
    }
  });

  test("ordinary commands are unaffected", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "bun test",
      "git status",
      "cat .sddx/tasks/x.json",
      "ls .sddx/specs",
      // Committing .sddx state is the framework's own persistence model. A
      // glob-based clause here blocked this while still allowing `rm -rf`,
      // blocking benign commands and missing destructive ones.
      "git add .sddx/receipts/*.json",
      // an unrelated *.config.json alongside a .sddx path must not trip the match
      "cat .sddx/tasks/x.json vite.config.json",
      "cat .sddx/x tsconfig.json",
    ]) {
      expect(approvalGate({ command, cwd }).decision, command).toBe("pass");
    }
  });
});

describe("auto-mode blast radius", () => {
  function planOn(cwd: string): string {
    return join(
      cwd,
      writeSpec(
        cwd,
        "2026-01-01-ship-the-widget",
        goalSpec({ title: "ship the widget", tasks: [{ id: "n0", scope: ["src/n0/**"] }] }),
      ),
    );
  }

  const node = (scope: string[]) => [{ alias: "n0", scope, oracleType: "command" }];

  test("a plan within bounds still self-approves", () => {
    const cwd = fixtureRepo();
    const spec = planOn(cwd);
    const d = decideGate(cwd, spec, node(["src/n0/**"]), "auto", 99, scopesOverlap, []);
    expect(d.ok).toBe(true);
    expect(d.mode).toBe("auto");
  });

  test("the compiled gates count as self-modification, not just their sources", () => {
    // The hooks invoke bin/sddx-run against dist/; a plan scoped to those
    // rewrites the enforcement machinery while overlapping none of the
    // originally-listed globs.
    const cwd = fixtureRepo();
    const spec = planOn(cwd);
    for (const scope of ["dist/**", "bin/**", ".claude/**"]) {
      const d = decideGate(cwd, spec, node([scope]), "auto", 99, scopesOverlap, []);
      expect(d.ok).toBe(false);
      expect(d.refusal).toContain(scope);
    }
    expect(SELF_MODIFYING_GLOBS).toContain("dist/**");
  });
});
