// The runtime resolver: which command generated adapter content uses to invoke
// sddx. Determinism is the point — see the byte-identity test below.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBashCommand } from "../src/lib/bashgate";
import { PACKAGE_MANAGERS, RUNTIME_SCOPES } from "../src/lib/config";
import {
  isSddxInvocation,
  pinnedRuntimeAdvice,
  sddxCommand,
  sddxInvocation,
} from "../src/lib/runtime";

describe("invocation forms", () => {
  test("global scope is the bare command, whatever the package manager", () => {
    for (const pm of PACKAGE_MANAGERS) {
      expect(sddxInvocation("global", pm)).toEqual(["sddx"]);
    }
  });

  test("project scope uses the package manager's verified no-install form", () => {
    expect(sddxCommand("project", "npm")).toBe("npm exec --offline --no -- sddx");
    expect(sddxCommand("project", "bun")).toBe("bunx --no-install sddx");
  });

  test("project scope never resolves sddx from PATH", () => {
    for (const pm of PACKAGE_MANAGERS) {
      expect(sddxInvocation("project", pm)[0]).not.toBe("sddx");
    }
  });

  test("arguments append cleanly to every form", () => {
    for (const scope of RUNTIME_SCOPES) {
      for (const pm of PACKAGE_MANAGERS) {
        const argv = [...sddxInvocation(scope, pm), "board", "--output", "json"];
        expect(argv.slice(-3)).toEqual(["board", "--output", "json"]);
        // npm needs its `--` separator to survive in front of the subcommand
        if (scope === "project" && pm === "npm") expect(argv).toContain("--");
      }
    }
  });

  test("no form references a package-internal path", () => {
    for (const scope of RUNTIME_SCOPES) {
      for (const pm of PACKAGE_MANAGERS) {
        const cmd = sddxCommand(scope, pm);
        expect(cmd).not.toContain("dist/");
        expect(cmd).not.toContain(".mjs");
        expect(cmd).not.toContain("sddx-run");
        expect(cmd).not.toContain("node_modules");
        expect(cmd).not.toContain("CLAUDE_PLUGIN_ROOT");
      }
    }
  });
});

describe("determinism", () => {
  test("the invocation depends only on policy, not on the machine", () => {
    // Same arguments, wildly different ambient state — the resolver takes no
    // machine input at all, which is what makes generated content reviewable.
    const first = sddxCommand("project", "npm");
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      expect(sddxCommand("project", "npm")).toBe(first);
      process.env.PATH = savedPath ?? "";
      expect(sddxCommand("project", "npm")).toBe(first);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("pinned-runtime advice", () => {
  test("names the exact project-local command to run instead", () => {
    expect(pinnedRuntimeAdvice("npm", ["board"])).toContain(
      "npm exec --offline --no -- sddx board",
    );
    expect(pinnedRuntimeAdvice("bun", ["board"])).toContain("bunx --no-install sddx board");
  });

  test("says the repository pins its runtime, rather than silently substituting", () => {
    expect(pinnedRuntimeAdvice("npm")).toContain("runtime_scope: project");
  });
});

/**
 * The claim these forms rest on: each runs the local binary, and neither
 * reaches the network when it is missing. Asserted against a real project tree
 * rather than trusted, because the whole zero-network guarantee depends on it.
 */
describe("verified no-install behavior", () => {
  function projectWithLocalBin(): string {
    const dir = mkdtempSync(join(tmpdir(), "sddx-pm-"));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "fakepkg"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }));
    writeFileSync(
      join(dir, "node_modules", "fakepkg", "package.json"),
      JSON.stringify({ name: "fakepkg", version: "1.0.0", bin: { probebin: "cli.js" } }),
    );
    const cli = join(dir, "node_modules", "fakepkg", "cli.js");
    writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("LOCAL BINARY RAN");\n');
    chmodSync(cli, 0o755);
    symlinkSync("../fakepkg/cli.js", join(dir, "node_modules", ".bin", "probebin"));
    return dir;
  }

  /** Substitutes the probe binary for `sddx` in a real invocation form. */
  const withProbe = (argv: readonly string[]): string[] =>
    argv.map((a) => (a === "sddx" ? "probebin" : a));

  for (const pm of PACKAGE_MANAGERS) {
    test(`${pm}: the form runs a present local binary`, () => {
      const dir = projectWithLocalBin();
      const [bin, ...args] = withProbe(sddxInvocation("project", pm));
      const r = spawnSync(bin as string, args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
      expect(r.stdout).toContain("LOCAL BINARY RAN");
      expect(r.status).toBe(0);
    });

    test(`${pm}: a missing local binary fails without fetching it`, () => {
      const dir = projectWithLocalBin();
      const argv = sddxInvocation("project", pm).map((a) =>
        a === "sddx" ? "sddx-absent-on-purpose-xyz" : a,
      );
      const [bin, ...args] = argv;
      const r = spawnSync(bin as string, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
      expect(r.status).not.toBe(0);
      // It must not have installed anything to satisfy the call.
      const combined = `${r.stdout}${r.stderr}`;
      expect(combined).not.toContain("added 1 package");
      expect(combined).not.toContain("LOCAL BINARY RAN");
    });
  }
});

/**
 * Regression from the high-effort review: sddx's own RED-phase Bash gate
 * blocked the invocation sddx generates for a bun-pinned repository, so the
 * phase machine was unreachable in the phase that needs it and no task could
 * be driven from RED to GREEN.
 */
describe("every generated invocation survives the RED-phase Bash gate", () => {
  for (const scope of RUNTIME_SCOPES) {
    for (const pm of PACKAGE_MANAGERS) {
      test(`${scope}/${pm}: the phase-machine commands are allowed`, () => {
        const invocation = sddxCommand(scope, pm);
        for (const sub of ["red-check t1", "task phase t1 RED --test-exit 1", "task allow t1 x"]) {
          const r = checkBashCommand(`${invocation} ${sub}`, []);
          const why = r.allow ? "" : ` — ${r.reason}`;
          expect(r.allow, `${invocation} ${sub}${why}`).toBe(true);
        }
      });
    }
  }

  test("the exemption does not open the wrapper up in general", () => {
    // Allow-listing `bunx` outright would have been the easy fix and the wrong
    // one: it would let any package run arbitrary code during RED.
    expect(checkBashCommand("bunx some-other-package --write", []).allow).toBe(false);
    expect(checkBashCommand("bunx --no-install prettier --write src/", []).allow).toBe(false);
    expect(checkBashCommand("npm exec --offline --no -- rimraf src/", []).allow).toBe(true);
  });

  test("isSddxInvocation matches only a full prefix", () => {
    expect(isSddxInvocation(["sddx", "board"])).toBe(true);
    expect(isSddxInvocation(["bunx", "--no-install", "sddx", "board"])).toBe(true);
    expect(isSddxInvocation(["npm", "exec", "--offline", "--no", "--", "sddx"])).toBe(true);
    expect(isSddxInvocation(["bunx", "sddx"])).toBe(false);
    expect(isSddxInvocation(["bunx", "--no-install", "other"])).toBe(false);
    expect(isSddxInvocation([])).toBe(false);
  });
});
