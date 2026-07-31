// Guards the README's privacy promise: sddx makes zero network calls.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers";

const NETWORK_PRIMITIVES =
  /from\s+["'](node:)?(http|https|net|tls|dgram|dns)["']|require\(["'](node:)?(http|https|net|tls|dgram|dns)["']\)|\bfetch\(|XMLHttpRequest|new\s+WebSocket/;

/**
 * Every shipped source and bundle, found by walking rather than by listing
 * directories: an explicit list silently stops covering a subdirectory the
 * moment someone adds one, which is exactly how a guarantee like this rots.
 */
function* sourceFiles(dir = repoRoot, roots = ["src", "dist"]): Generator<string> {
  for (const root of roots) {
    yield* walk(join(dir, root));
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) yield abs;
  }
}

describe("privacy guarantee", () => {
  test("no network primitives in shipped sources or bundles", () => {
    for (const file of sourceFiles()) {
      const hit = NETWORK_PRIMITIVES.exec(readFileSync(file, "utf8"));
      expect(hit === null ? null : `${file}: ${hit[0]}`).toBeNull();
    }
  });
});

describe("the package-manager exception is bounded", () => {
  test("only the bootstrap plans a package-manager command", () => {
    // The README names one exception to the zero-network promise: an
    // explicitly approved package-manager install during `sddx init`. It has
    // to stay confined to the bootstrap, or "one exception" stops being true.
    const offenders: string[] = [];
    for (const file of walk(join(repoRoot, "src"))) {
      if (file.endsWith("init.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (/npm install|bun add|yarn add|pnpm add/.test(src)) offenders.push(file);
    }
    // doctor may *name* an install command as remediation without running one.
    expect(offenders.filter((f) => !f.endsWith("doctor.ts"))).toEqual([]);
  });

  test("no hot path runs a package manager", () => {
    for (const rel of ["src/lib/hookdispatch.ts", "src/tdd-gate.ts", "src/bootstrap.ts"]) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src).not.toContain("npm install");
      expect(src).not.toContain("bun add");
    }
  });
});
