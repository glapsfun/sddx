// Guards the README's privacy promise: sddx makes zero network calls.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers";

const NETWORK_PRIMITIVES =
  /from\s+["'](node:)?(http|https|net|tls|dgram|dns)["']|require\(["'](node:)?(http|https|net|tls|dgram|dns)["']\)|\bfetch\(|XMLHttpRequest|new\s+WebSocket/;

function* sourceFiles(): Generator<string> {
  for (const dir of ["src", join("src", "lib"), "dist"]) {
    for (const f of readdirSync(join(repoRoot, dir))) {
      if (f.endsWith(".ts") || f.endsWith(".mjs")) yield join(repoRoot, dir, f);
    }
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
