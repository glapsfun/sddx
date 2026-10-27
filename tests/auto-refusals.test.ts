// Autonomy bounds as HARD REFUSALS, not gate arming.
//
// The bounds used to degrade `auto` into `human`: the run halted and told the
// user to approve. That halt was already terminal, but it recorded a hybrid, a
// run configured `auto` whose token said a human approved it, and
// `requested_mode`/`degraded_reason` existed only to describe that hybrid.
// Removing the degradation removes the hybrid, so a bound now fails outright
// and names the reviewed-configuration edit instead of offering a token.
//
// The protected-path bound is the reason this matters. The autonomous blocker
// rule cannot rest on a model reporting its own uncertainty; that is a model
// claim of the class this project replaced with exit codes everywhere else.
// SENSITIVE_SEGMENTS and SENSITIVE_GLOBS are the deterministic half: code
// constants, unit tested, that fire whether or not anything self-reported a
// problem.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGate, readApproval, SENSITIVE_GLOBS, SENSITIVE_SEGMENTS } from "../src/lib/approval";
import { approvalGate } from "../src/lib/approvalgate";
import { scopesOverlap } from "../src/lib/glob-overlap";
import { fixtureClone, fixtureRepo, writeConfig } from "./fixtures";
import { goalIds, goalSpec, repoRoot, sddx, writeSpec } from "./helpers";

// Mode is config-only by design (config.ts interactionMode): the environment is
// part of the command line the agent composes, so tests write config as a user does.
function withMode(cwd: string, mode: "human" | "auto", autoMaxTasks?: number): void {
  writeConfig(cwd, {
    interaction_mode: mode,
    ...(autoMaxTasks ? { auto_max_tasks: autoMaxTasks } : {}),
  });
}

/** A spec with one task per entry; `null` declares no scope at all. */
function planRepo(cwd: string, scopes: (string | null)[]): string {
  return writeSpec(
    cwd,
    "2026-01-01-ship-the-widget",
    goalSpec({
      title: "ship the widget",
      tasks: scopes.map((scope, i) => ({ id: `n${i}`, scope: scope === null ? null : [scope] })),
    }),
  );
}

const nodesFor = (scopes: string[][]) =>
  scopes.map((scope, i) => ({ alias: `n${i}`, scope, oracleType: "command" }));

/** decideGate over a throwaway spec, so the hash is real and only `scopes` vary. */
function gate(scopes: string[][], mode: "human" | "auto" = "auto") {
  const cwd = fixtureRepo();
  const spec = join(cwd, planRepo(cwd, ["x"]));
  return decideGate(cwd, spec, nodesFor(scopes), mode, 99, scopesOverlap, []);
}

const tokens = (cwd: string): string[] => {
  const dir = join(cwd, ".sddx", "approvals");
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("protected-path bound", () => {
  test("a scope naming a protected area refuses in auto mode", () => {
    const d = gate([["src/auth/**"]]);
    expect(d.ok).toBe(false);
    expect(d.refusal).toBeDefined();
    expect(d.refusal).toContain("n0");
    expect(d.refusal).toContain("auth");
  });

  test("naming catches the area at any nesting depth", () => {
    // The reason this is a segment-name rule and not glob overlap: overlap
    // against an any-depth pattern refuses every scope ending in a doubled
    // star, which turns auto mode off instead of bounding it.
    for (const scope of ["auth/**", "src/auth/**", "services/api/auth/**"]) {
      expect(gate([[scope]]).refusal, `${scope} should refuse`).toBeDefined();
    }
  });

  test("naming the area as a file or a suffixed directory still refuses", () => {
    // Whole-segment equality caught `src/auth/**` but let `src/auth.ts` and
    // `src/auth-service/**` through: scopes that name the protected area MORE
    // precisely than the directory form that was refused. Word-wise comparison
    // closes that, and the suffix form (`user-auth.ts`) with it.
    for (const scope of [
      "src/auth.ts",
      "lib/billing.ts",
      "db/migrations.sql",
      "src/auth-service/**",
      "lib/user-auth.ts",
    ]) {
      expect(gate([[scope]]).refusal, `${scope} should refuse`).toBeDefined();
    }
  });

  test("a wildcard prefix does not defeat a protected filename", () => {
    // SENSITIVE_FILENAMES are anchored with `^`, so testing them against the
    // raw segment made the refusal depend on how the planner spelled the glob:
    // `ops/.env*` refused, `ops/*.env` did not. Wildcards are stripped first.
    for (const scope of [
      "ops/*.env",
      "deploy/*Dockerfile",
      "deploy/Docker*file",
      "x/*docker-compose*",
    ]) {
      expect(gate([[scope]]).refusal, `${scope} should refuse`).toBeDefined();
    }
  });

  test("the word boundary keeps the bound from overreaching", () => {
    // The cost of word-wise matching would be refusing every scope that merely
    // starts with a protected name. It does not: these share a prefix, not a
    // word, and auto mode must still be usable.
    for (const scope of ["authors/**", "authority/**", "src/authorship.ts"]) {
      expect(gate([[scope]]).refusal, `${scope} should pass`).toBeUndefined();
    }
  });

  test("every protected segment is matched", () => {
    for (const seg of SENSITIVE_SEGMENTS) {
      expect(gate([[`src/${seg}/**`]]).refusal, `${seg} should refuse`).toBeDefined();
    }
  });

  test("every root-anchored protected glob is matched", () => {
    for (const glob of SENSITIVE_GLOBS) {
      expect(gate([[glob]]).refusal, `${glob} should refuse`).toBeDefined();
    }
  });

  test("an ordinary nested scope is NOT refused; the bound bounds, it does not veto", () => {
    for (const scope of ["src/**", "src/widget/**", "docs/**", "tests/unit/**"]) {
      expect(gate([[scope]]).refusal, `${scope} should pass`).toBeUndefined();
    }
  });

  test("an unconfined task refuses; an empty scope may write any protected path", () => {
    const d = gate([[]]);
    expect(d.ok).toBe(false);
    expect(d.refusal).toContain("unconfined");
  });

  test("human mode is unaffected; explicit approval is already required there", () => {
    expect(gate([["src/auth/**"]], "human").refusal).toBeUndefined();
  });

  test("an ordinary scope is unaffected", () => {
    const d = gate([["src/widget/**"]]);
    expect(d.ok).toBe(true);
    expect(d.refusal).toBeUndefined();
  });
});

describe("bounds refuse rather than arm the gate", () => {
  test("over the ceiling: refusal, nonzero exit, no token, no goal", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**", "src/n2/**", "src/n3/**"]);
    withMode(cwd, "auto", 3);
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    // exit 3 is "approval required"; a refusal is not that
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("auto_max_tasks");
    expect(tokens(cwd)).toEqual([]);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("self-modifying scope: refusal, no token, no goal", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["hooks/**"]);
    withMode(cwd, "auto", 99);
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain("enforcement paths");
    expect(tokens(cwd)).toEqual([]);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("protected path: refusal through the CLI, no token, no goal", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["db/migrations/**"]);
    withMode(cwd, "auto", 99);
    const r = sddx(cwd, "plan", "start", rel);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(3);
    expect(r.stderr).toContain('protected area "migrations"');
    expect(tokens(cwd)).toEqual([]);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("auto cannot approve its way past a bound", () => {
    // The degradation path used to let an approval satisfy a bound in auto
    // mode. That is the hybrid this change removes: approving is a human act,
    // so it belongs to human mode, reached by editing reviewed configuration.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["src/n0/**", "src/n1/**", "src/n2/**", "src/n3/**"]);
    withMode(cwd, "auto", 3);
    const r = sddx(cwd, "plan", "approve", rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auto_max_tasks");
    expect(tokens(cwd)).toEqual([]);
  });

  test("a refusal names the configuration edit, never a flag or an env var", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["hooks/**"]);
    withMode(cwd, "auto", 99);
    const out = sddx(cwd, "plan", "start", rel).stderr;
    expect(out).toContain("interaction_mode");
    expect(out).toContain(".sddx/config.json");
    expect(out).not.toContain("--mode");
    expect(out).not.toContain("SDDX_INTERACTION_MODE");
  });
});

describe("approval tokens", () => {
  test("a new token records no degradation fields", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["src/n0/**"]);
    withMode(cwd, "auto");
    expect(sddx(cwd, "plan", "approve", rel).status).toBe(0);
    const [name] = tokens(cwd);
    const token = JSON.parse(readFileSync(join(cwd, ".sddx", "approvals", name as string), "utf8"));
    expect(token.requested_mode).toBeUndefined();
    expect(token.degraded_reason).toBeUndefined();
  });

  test("a token written before this change still parses, fields intact", () => {
    // Degradation is gone, but tokens recording it are on disk and an audit
    // must still read them. Read-only compatibility, not resurrection.
    const cwd = fixtureRepo();
    const hash = "a".repeat(64);
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "approvals", `${hash}.json`),
      JSON.stringify({
        plan_sha256: hash,
        mode: "human",
        requested_mode: "auto",
        degraded_reason: "plan has 4 nodes, over the auto_max_tasks ceiling of 3",
        at: "2026-07-01T00:00:00.000Z",
        amendments: [],
      }),
    );
    const a = readApproval(cwd, hash);
    expect(a).not.toBeNull();
    expect(a?.mode).toBe("human");
    expect(a?.requested_mode).toBe("auto");
    expect(a?.degraded_reason).toContain("auto_max_tasks");
  });
});

describe("the CLI and the hook cannot disagree about a refusal", () => {
  // The hook raises the user's permission dialog; the CLI exits non-zero. A
  // refusal must reach the user as a REFUSAL from exactly one of them. If the
  // hook asked, the human would be invited to approve something the CLI is
  // about to reject outright, which is the degraded-mode UX this change removes.
  for (const [name, scope] of [
    ["self-modifying", "hooks/**"],
    ["protected area", "src/auth/**"],
    ["root-anchored protected path", "infra/**"],
  ] as const) {
    test(`${name}: the hook stays silent and the CLI refuses`, () => {
      const { clone: cwd } = fixtureClone();
      const rel = planRepo(cwd, [scope]);
      withMode(cwd, "auto", 99);

      const hook = approvalGate({ command: `sddx plan start ${rel}`, cwd });
      expect(hook.decision).toBe("pass");

      const r = sddx(cwd, "plan", "start", rel);
      expect(r.status).not.toBe(0);
      expect(r.status).not.toBe(3);
      expect(goalIds(cwd)).toEqual([]);
    });
  }

  test("a plan within every bound: both let it through", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, ["src/widget/**"]);
    withMode(cwd, "auto", 99);
    expect(approvalGate({ command: `sddx plan start ${rel}`, cwd }).decision).toBe("pass");
    expect(sddx(cwd, "plan", "start", rel).status).toBe(0);
  });
});

describe("mode is never presented as settable by flag or environment", () => {
  test("no CLI message offers --mode or an env var as the remedy", () => {
    // A refusal message used to name both `--mode human` and
    // `SDDX_INTERACTION_MODE=human`. Neither has ever existed (mode is
    // config-only by design), so it sent users to a fix that silently does nothing.
    const src = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
    expect(src).not.toContain("SDDX_INTERACTION_MODE");
    expect(src).not.toContain("--mode human");
    expect(src).not.toContain("--mode auto");
  });
});
