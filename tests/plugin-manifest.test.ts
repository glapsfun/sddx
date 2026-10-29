import { describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "./helpers";
import { scenario } from "./scenario";

const json = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;

describe("plugin and marketplace manifests", () => {
  scenario("claude-plugin", "Plugin and package versions agree", () => {
    const plugin = json(".claude-plugin/plugin.json");
    expect(plugin.name).toBe("sddx");
    expect(plugin.version).toBe(json("package.json").version as string);
  });

  scenario("claude-plugin", "Marketplace lists the root plugin", () => {
    const market = json(".claude-plugin/marketplace.json");
    expect(market.name).toBe("sddx");
    const plugins = market.plugins as Record<string, unknown>[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("sddx");
    expect(plugins[0]?.source).toBe("./");
    // one source of truth for the version: the plugin manifest
    expect(plugins[0]?.version).toBeUndefined();
  });

  scenario("claude-plugin", "A release bumps the plugin version", () => {
    const config = json("release-please-config.json");
    const root = (config.packages as Record<string, Record<string, unknown>>)["."];
    const extra = (root?.["extra-files"] ?? []) as Record<string, string>[];
    const bumps = (path: string) =>
      extra.some((f) => f.type === "json" && f.path === path && f.jsonpath === "$.version");
    expect(bumps("package.json")).toBe(true);
    expect(bumps(".claude-plugin/plugin.json")).toBe(true);
  });

  scenario("codex-plugin", "Versions agree", () => {
    const codex = json(".codex-plugin/plugin.json");
    expect(codex.name).toBe("sddx");
    const version = json("package.json").version as string;
    expect(codex.version).toBe(version);
    expect(json(".claude-plugin/plugin.json").version).toBe(version);
  });

  scenario("codex-plugin", "Referenced paths exist", () => {
    const codex = json(".codex-plugin/plugin.json");
    expect(codex.skills).toBe("./skills/");
    expect(codex.hooks).toBe("./hooks/hooks-codex.json");
    const paths: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string" && v.startsWith(".")) paths.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(codex);
    expect(paths.length).toBeGreaterThan(1);
    for (const p of paths) {
      expect({ p, relative: p.startsWith("./") }).toEqual({ p, relative: true });
      const abs = resolve(repoRoot, p);
      expect({ p, inside: abs.startsWith(repoRoot), exists: existsSync(abs) }).toEqual({
        p,
        inside: true,
        exists: true,
      });
    }
  });

  scenario("codex-plugin", "A release bumps the Codex manifest", () => {
    const config = json("release-please-config.json");
    const root = (config.packages as Record<string, Record<string, unknown>>)["."];
    const extra = (root?.["extra-files"] ?? []) as Record<string, string>[];
    expect(
      extra.some(
        (f) =>
          f.type === "json" && f.path === ".codex-plugin/plugin.json" && f.jsonpath === "$.version",
      ),
    ).toBe(true);
  });

  scenario(
    "claude-plugin",
    "Strict validation passes",
    () => {
      // CI installs the CLI and sets SDDX_REQUIRE_CLAUDE, so only a local run may skip
      const claude = Bun.which("claude");
      if (!claude) {
        if (process.env.SDDX_REQUIRE_CLAUDE === "1") {
          throw new Error("SDDX_REQUIRE_CLAUDE=1 but the claude CLI is not on PATH");
        }
        console.warn("claude CLI not on PATH; skipping `claude plugin validate`");
        return;
      }
      const r = spawnSync(claude, ["plugin", "validate", ".", "--strict"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`claude plugin validate failed:\n${r.stdout}${r.stderr}`);
    },
    60_000,
  );
});
