// Regressions for ways the plan-approval gate could be walked around without a
// human ever seeing the dialog. Each test here corresponds to a working bypass:
// the gate reported itself satisfied while nobody had approved anything.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, SELF_MODIFYING_GLOBS } from "../src/lib/approval";
import { approvalGate, gatedAction, lex } from "../src/lib/approvalgate";
import { bashGate } from "../src/lib/bashgate";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { fixtureRepo } from "./fixtures";

describe("gatedAction sees through shell syntax", () => {
  test("a `#` inside a quoted argument does not hide the rest of the line", () => {
    // The comment strip ran to end-of-string with no quote awareness, so
    // everything after the `#` in the commit message vanished from the gate's
    // view — including the approve, which then ran with no dialog.
    expect(gatedAction('git commit -m "fix #12" && sddx graph approve --graph plan.yaml')).toBe(
      "approve",
    );
    expect(gatedAction("git commit -m 'see #9' ; sddx graph create --graph plan.yaml")).toBe(
      "create",
    );
  });

  test("a real comment is still a comment", () => {
    expect(gatedAction("bun test # sddx graph approve --graph plan.yaml")).toBe(null);
    expect(gatedAction("# sddx graph create --graph plan.yaml")).toBe(null);
  });

  test("quoted subcommands still match", () => {
    for (const cmd of [
      'sddx graph "approve" --graph plan.yaml',
      "sddx graph 'approve' --graph plan.yaml",
      'sddx "graph" approve --graph plan.yaml',
    ]) {
      expect(gatedAction(cmd)).toBe("approve");
    }
    expect(gatedAction('sddx "graph" create --graph plan.yaml')).toBe("create");
  });

  test("a line continuation is spliced, not treated as a segment break", () => {
    // The shell runs this as one command; splitting on the raw newline left
    // `graph` and `approve` in different segments, so neither matched.
    expect(gatedAction("sddx graph \\\napprove --graph plan.yaml")).toBe("approve");
    expect(gatedAction("sddx graph \\\ncreate --graph plan.yaml")).toBe("create");
  });

  test("--dry-run still exempts a create, per segment", () => {
    expect(gatedAction("sddx graph create --graph plan.yaml --dry-run")).toBe(null);
    // ...but a dry run in one segment must not vouch for a real create in another
    expect(
      gatedAction("sddx graph create --graph p.yaml --dry-run && sddx graph create --graph p.yaml"),
    ).toBe("create");
  });

  test("a wrapper does not hide the command inside one token", () => {
    // Quote-aware lexing is what makes `'sddx graph approve …'` a single token —
    // the naive splitter this replaced caught these only by accident, because it
    // never stripped quotes. Losing them would reintroduce a no-dialog approval.
    for (const cmd of [
      "sh -c 'sddx graph approve --graph p.yaml'",
      'bash -c "sddx graph approve --graph p.yaml"',
      "eval 'sddx graph approve --graph p.yaml'",
      `sh -c "sh -c 'sddx graph approve --graph p.yaml'"`,
    ]) {
      expect(gatedAction(cmd)).toBe("approve");
    }
    expect(gatedAction("sh -c 'sddx graph create --graph p.yaml'")).toBe("create");
    expect(gatedAction("sh -c 'sddx graph create --graph p.yaml --dry-run'")).toBe(null);
  });

  test("approve wins over create wherever it appears in the line", () => {
    // Per-segment ordering returned on the first match, so a gate-satisfiable
    // create in an earlier segment reported the whole line as a create — and the
    // approve then ran with no dialog, minting a token for an arbitrary plan.
    expect(
      gatedAction("sddx graph create --graph good.yaml && sddx graph approve --graph evil.yaml"),
    ).toBe("approve");
    expect(
      gatedAction("sddx graph create --graph good.yaml ; sddx graph approve --graph evil.yaml"),
    ).toBe("approve");
    expect(
      gatedAction(
        "sddx graph create --graph a.yaml --dry-run && sh -c 'sddx graph approve --graph b.yaml'",
      ),
    ).toBe("approve");
  });

  test("quoting the phrase is not a gated action", () => {
    // Recursion is limited to wrapper commands. Unwrapping every token that
    // contained whitespace made a commit message raise an approval dialog, and a
    // dialog that cries wolf trains the user to click through the one prompt the
    // design rests on.
    expect(gatedAction('git commit -m "run sddx graph approve first"')).toBe(null);
    expect(gatedAction('rg "graph approve" src/')).toBe(null);
    expect(gatedAction('echo "remember: sddx graph create --graph p.yaml"')).toBe(null);
  });

  test("global flags between the subcommand pair do not hide it", () => {
    // parseOutputFlag strips --output/--no-color from ANY position before
    // dispatch, so `graph --output json approve` really does run graph approve.
    expect(gatedAction("sddx graph --output json approve --graph p.yaml")).toBe("approve");
    expect(gatedAction("sddx graph --no-color approve --graph p.yaml")).toBe("approve");
    expect(gatedAction("sddx graph --output json create --graph p.yaml")).toBe("create");
    // a different subcommand still is not a match
    expect(gatedAction("sddx graph show approve")).toBe(null);
  });

  test("lex reports every expansion as opaque, not just substitution", () => {
    for (const cmd of [
      "sddx graph approve --graph $(ls *.yaml)",
      "`sddx graph approve`",
      'sddx graph approve --graph "$(cat f)"',
      "sddx graph $'approve' --graph p.yaml",
      "A=approve; sddx graph $A --graph p.yaml",
      "sddx graph ${SUB} --graph p.yaml",
    ]) {
      expect(lex(cmd).opaque).toBe(true);
    }
    expect(lex("sddx graph approve --graph plan.yaml").opaque).toBe(false);
    // `$` inside single quotes is literal to the shell, so it is not an expansion
    expect(lex("echo 'costs $5'").opaque).toBe(false);
    // an unterminated quote means the parse does not describe what will run
    expect(lex('sddx graph approve --graph "plan.yaml').opaque).toBe(true);
  });

  test("an opaque line naming sddx AND graph asks rather than passing", () => {
    const cwd = fixtureRepo();
    expect(approvalGate({ command: "A=approve; sddx graph $A --graph p.yaml", cwd }).decision).toBe(
      "ask",
    );
    // Scoped to both words. Requiring only `sddx` asked on every command using a
    // variable near a path containing "sddx" — including plain reads, on the hot
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
    // while awaiting approval — the RED-phase allow-list never applied here, so
    // this shell write forged a token with nothing looking.
    const d = bashGate({
      command: `printf '{}' > .sddx/approvals/deadbeef.json`,
      cwd,
    });
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.reason).toContain(".sddx/approvals/");
  });

  test("writing to the token directory by any spelling is refused", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "mkdir -p .sddx/approvals && echo x > .sddx/approvals/a.json",
      "cp /tmp/a.json .sddx/tasks/../approvals/a.json",
      "tee .sddx/approvals/a.json",
      // The RED-phase allow-list exists to permit test runs, so it admits every
      // one of these — using it as a read-only proxy reopened the forge path.
      "find .sddx/approvals -name '*.json' -delete",
      "find .sddx/approvals -type d -exec cp /tmp/forged.json {}/a.json ;",
      "bun run /tmp/forge.ts .sddx/approvals/a.json",
      "node /tmp/forge.js .sddx/approvals/a.json",
      "python3 /tmp/forge.py .sddx/approvals/a.json",
      "make forge FILE=.sddx/approvals/a.json",
    ]) {
      expect(bashGate({ command, cwd }).allow).toBe(false);
    }
  });

  test(".sddx/config.json is refused too — it decides whether the gate arms", () => {
    const cwd = fixtureRepo();
    for (const command of [
      `echo '{"execution_mode":"auto"}' > .sddx/config.json`,
      // redirect glued to the filename: anchoring on an explicit character class
      // dropped this spelling, which is exactly the write being guarded
      `cd .sddx;printf '{"execution_mode":"auto"}'>config.json`,
      "node /tmp/forge.js .sddx/config.json",
    ]) {
      const d = bashGate({ command, cwd });
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toContain("execution_mode");
    }
  });

  test("reads of those paths are NOT blocked", () => {
    // A token is not a secret, and this repo's own source and tests reference
    // these paths constantly — refusing to grep them would make ordinary work
    // here impossible. The allow-list already rejects every write path.
    const cwd = fixtureRepo();
    for (const command of [
      "grep -rn '.sddx/approvals' src/",
      "rg approvals .sddx",
      "cat .sddx/approvals/a.json",
      "ls .sddx/config.json",
      "git diff .sddx/config.json",
    ]) {
      expect(bashGate({ command, cwd }).allow).toBe(true);
    }
  });

  test("ordinary commands are unaffected", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "bun test",
      "git status",
      "cat .sddx/tasks/x.json",
      "ls .sddx/drafts",
      // Committing .sddx state is the framework's own persistence model. A
      // glob-based clause here blocked this while still allowing `rm -rf` —
      // blocking benign commands and missing destructive ones.
      "git add .sddx/receipts/*.json",
      // an unrelated *.config.json alongside a .sddx path must not trip the match
      "cat .sddx/tasks/x.json vite.config.json",
      "cat .sddx/x tsconfig.json",
    ]) {
      expect(bashGate({ command, cwd }).allow).toBe(true);
    }
  });
});

describe("auto-mode blast radius", () => {
  const SPEC = `task: build it
success_criteria:
  - "it works"
scope:
  - "src/n0/**"
oracle:
  type: command
  run: "true"
`;

  function planOn(cwd: string): string {
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "n0.yaml"), SPEC);
    const rel = join(".sddx", "drafts", "graph.yaml");
    writeFileSync(
      join(cwd, rel),
      "goal: ship the widget\ntasks:\n  - alias: n0\n    spec: n0.yaml\n",
    );
    return join(cwd, rel);
  }

  const node = (scope: string[]) => [{ alias: "n0", scope, oracleType: "command" }];

  test("workspace none does not self-approve", () => {
    // `none` runs every task in the user's live checkout instead of an isolated
    // worktree. The token path already refused to let a `worktree` render
    // authorize it, but that check needs a token — on the self-approving auto
    // path nothing was checking it at all.
    const cwd = fixtureRepo();
    const g = planOn(cwd);
    const d = decideGate(cwd, g, node(["src/n0/**"]), "auto", 99, scopesOverlap, "none");
    expect(d.ok).toBe(false);
    // A refusal now, not a degradation into human: the bound fails the plan
    // rather than offering a token that would run it unattended anyway.
    expect(d.refusal).toContain("none");
  });

  test("worktree still self-approves within bounds", () => {
    const cwd = fixtureRepo();
    const g = planOn(cwd);
    const d = decideGate(cwd, g, node(["src/n0/**"]), "auto", 99, scopesOverlap, "worktree");
    expect(d.ok).toBe(true);
    expect(d.mode).toBe("auto");
  });

  test("the compiled gates count as self-modification, not just their sources", () => {
    // hooks.json invokes bin/sddx-run against dist/hooks.mjs — a plan scoped to
    // those rewrites the enforcement machinery while overlapping none of the
    // originally-listed globs.
    const cwd = fixtureRepo();
    const g = planOn(cwd);
    for (const scope of ["dist/**", "bin/**", ".claude/**"]) {
      const d = decideGate(cwd, g, node([scope]), "auto", 99, scopesOverlap, "worktree");
      expect(d.ok).toBe(false);
      expect(d.refusal).toContain(scope);
    }
    expect(SELF_MODIFYING_GLOBS).toContain("dist/**");
  });
});
