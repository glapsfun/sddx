// Regressions for ways the plan-approval gate could be walked around without a
// human ever seeing the dialog. Each test here corresponds to a working bypass:
// the gate reported itself satisfied while nobody had approved anything.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, SELF_MODIFYING_GLOBS } from "../src/lib/approval";
import { gatedAction, lex } from "../src/lib/approvalgate";
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

  test("lex reports command substitution as opaque", () => {
    expect(lex("sddx graph approve --graph $(ls *.yaml)").opaque).toBe(true);
    expect(lex("`sddx graph approve`").opaque).toBe(true);
    expect(lex('sddx graph approve --graph "$(cat f)"').opaque).toBe(true);
    expect(lex("sddx graph approve --graph plan.yaml").opaque).toBe(false);
    // an unterminated quote means the parse does not describe what will run
    expect(lex('sddx graph approve --graph "plan.yaml').opaque).toBe(true);
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

  test("reaching the token directory by any spelling is refused", () => {
    const cwd = fixtureRepo();
    for (const command of [
      "mkdir -p .sddx/approvals && echo x > .sddx/approvals/a.json",
      "cp /tmp/a.json .sddx/tasks/../approvals/a.json",
      "cat .sddx/approvals/a.json",
    ]) {
      expect(bashGate({ command, cwd }).allow).toBe(false);
    }
  });

  test(".sddx/config.json is refused too — it decides whether the gate arms", () => {
    const cwd = fixtureRepo();
    const d = bashGate({ command: `echo '{"execution_mode":"auto"}' > .sddx/config.json`, cwd });
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.reason).toContain("execution_mode");
  });

  test("ordinary commands are unaffected", () => {
    const cwd = fixtureRepo();
    for (const command of ["bun test", "git status", "cat .sddx/tasks/x.json", "ls .sddx/drafts"]) {
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
    expect(d.mode).toBe("human");
    expect(d.degradedReason).toContain("none");
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
      expect(d.mode).toBe("human");
    }
    expect(SELF_MODIFYING_GLOBS).toContain("dist/**");
  });
});
