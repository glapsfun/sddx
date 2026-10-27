import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { repoRoot } from "./helpers";

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Relative link targets in a markdown file, outside fenced code blocks. */
function links(text: string): string[] {
  const prose = text.replace(/^(`{3,}|~{3,})[\s\S]*?^\1/gm, "");
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1] ?? "")
    .filter((t) => !/^[a-z]+:/i.test(t) && !t.startsWith("#"))
    .map((t) => t.split("#")[0] ?? "");
}

describe("relative links in docs/ and README.md resolve", () => {
  for (const file of [...markdownFiles(join(repoRoot, "docs")), join(repoRoot, "README.md")]) {
    test(relative(repoRoot, file), () => {
      const broken = links(readFileSync(file, "utf8")).filter(
        (t) => !existsSync(join(dirname(file), t)),
      );
      expect(broken).toEqual([]);
    });
  }
});
