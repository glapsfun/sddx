// `sddx doctor` — say what is wrong, and say exactly how to fix it.
//
// The rule this module is built around: a failing check without a remediation
// command is a defect, not a diagnostic. A user who runs `doctor` because
// something is broken should be able to copy a line out of the output and be
// done. Every `fail` and `warn` below therefore carries `fix`.
//
// It is also strictly read-only. `doctor` is what people reach for when they
// already do not trust the state of things; a diagnostic that mutates is a
// diagnostic nobody can safely run twice.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterContext } from "./adapter";
import { planAdapter, readManifest } from "./adapter";
import { CONFIG_SCHEMA_VERSION, type ResolvedConfig, validateConfigObject } from "./config";
import { sddxCommand } from "./runtime";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
  /** The exact command that resolves this. Required for warn and fail. */
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** True when at least one check failed — the process exit code follows this. */
  failed: boolean;
}

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const warn = (id: string, detail: string, fix: string): Check => ({
  id,
  status: "warn",
  detail,
  fix,
});
const fail = (id: string, detail: string, fix: string): Check => ({
  id,
  status: "fail",
  detail,
  fix,
});

const BUN_INSTALL = "curl -fsSL https://bun.sh/install | bash";

function which(bin: string): string | null {
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: true });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out !== "" ? out : null;
}

function checkBun(): Check {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  if (bun) return pass("bun", `bun ${bun.version} (running this process)`);
  const found = which("bun");
  if (found) return pass("bun", `bun found at ${found}`);
  return fail("bun", "bun is not on PATH, and it is the only supported runtime", BUN_INSTALL);
}

function checkGit(root: string | null, cwd: string): Check {
  if (root === null) {
    return fail(
      "git-repository",
      `${cwd} is not inside a git repository`,
      "git init   # or run sddx from inside an existing repository",
    );
  }
  return pass("git-repository", root);
}

function checkConfig(root: string): Check {
  const path = join(root, ".sddx", "config.json");
  if (!existsSync(path)) {
    return fail("project-config", ".sddx/config.json is missing", "sddx init");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(
      "project-config",
      `.sddx/config.json is not valid JSON: ${(e as Error).message}`,
      "sddx init",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("project-config", ".sddx/config.json is not a JSON object", "sddx init");
  }
  const warnings = validateConfigObject(parsed as Record<string, unknown>);
  if (warnings.length > 0) {
    return warn("project-config", warnings.join("; "), "sddx config validate");
  }
  return pass("project-config", `schema_version ${CONFIG_SCHEMA_VERSION}`);
}

/**
 * Is `@glapsfun/sddx` resolvable as a project dependency?
 *
 * Checked by looking for the installed package rather than by running the
 * package manager: `doctor` must not mutate, and several package managers
 * install on a miss.
 */
function projectDependency(root: string): { declared: boolean; installedVersion: string | null } {
  let declared = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    declared =
      pkg.dependencies?.["@glapsfun/sddx"] !== undefined ||
      pkg.devDependencies?.["@glapsfun/sddx"] !== undefined;
  } catch {
    declared = false;
  }
  let installedVersion: string | null = null;
  try {
    const manifest = join(root, "node_modules", "@glapsfun", "sddx", "package.json");
    installedVersion = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    installedVersion = null;
  }
  return { declared, installedVersion };
}

function checkRuntimeScope(root: string, cfg: ResolvedConfig, runningVersion: string): Check[] {
  const invocation = sddxCommand(cfg.runtime_scope, cfg.package_manager);
  const checks: Check[] = [pass("runtime-scope", `${cfg.runtime_scope} → \`${invocation}\``)];

  if (cfg.runtime_scope === "global") {
    const found = which("sddx");
    checks.push(
      found
        ? pass("runtime-resolution", `sddx resolves to ${found}`)
        : fail(
            "runtime-resolution",
            "runtime_scope is global but no `sddx` is on PATH",
            "npm install -g @glapsfun/sddx",
          ),
    );
    return checks;
  }

  const { declared, installedVersion } = projectDependency(root);
  const install =
    cfg.package_manager === "bun"
      ? "bun add --dev @glapsfun/sddx"
      : "npm install --save-dev @glapsfun/sddx";

  if (!declared) {
    checks.push(
      fail(
        "runtime-resolution",
        "runtime_scope is project but @glapsfun/sddx is not a project dependency",
        install,
      ),
    );
  } else if (installedVersion === null) {
    checks.push(
      fail(
        "runtime-resolution",
        "@glapsfun/sddx is declared but not installed (no node_modules entry)",
        cfg.package_manager === "bun" ? "bun install" : "npm install",
      ),
    );
  } else if (installedVersion !== runningVersion) {
    // Not a failure: running a global sddx to inspect a pinned project is a
    // normal thing to do. It is a mismatch worth naming, with both versions,
    // because a stale local copy is exactly what makes generated content drift.
    checks.push(
      warn(
        "runtime-resolution",
        `project-local @glapsfun/sddx is ${installedVersion}, this process is ${runningVersion}`,
        install,
      ),
    );
  } else {
    checks.push(pass("runtime-resolution", `project-local @glapsfun/sddx ${installedVersion}`));
  }

  // A global binary inspecting a pinned repository must say so rather than
  // quietly standing in for the pinned one.
  const globalBin = which("sddx");
  if (globalBin !== null) {
    checks.push(
      warn(
        "runtime-mismatch",
        `this repository pins its runtime, but a global sddx exists at ${globalBin}`,
        `${invocation} doctor`,
      ),
    );
  }
  return checks;
}

function checkAdapters(
  root: string,
  cfg: ResolvedConfig,
  adapters: Record<string, Adapter>,
  ctx: AdapterContext,
): Check[] {
  if (cfg.adapters.length === 0) {
    return [pass("adapters", "no adapters enabled")];
  }
  const checks: Check[] = [];
  for (const name of cfg.adapters) {
    const adapter = adapters[name];
    if (!adapter) {
      checks.push(
        fail(
          `adapter:${name}`,
          `config enables adapter "${name}", which this sddx does not implement`,
          "sddx config validate",
        ),
      );
      continue;
    }
    const manifest = readManifest(root, name);
    const plan = planAdapter(root, adapter, ctx);

    if (plan.conflicts.length > 0) {
      checks.push(
        fail(
          `adapter:${name}`,
          plan.conflicts.map((c) => `${c.path} — ${c.reason}`).join("; "),
          `sddx sync --adapter ${name}   # or --force to overwrite (keeps a .bak)`,
        ),
      );
      continue;
    }
    const stale = plan.dispositions.filter((d) => d.kind === "create" || d.kind === "update");
    if (stale.length > 0) {
      checks.push(
        warn(
          `adapter:${name}`,
          `${stale.length} generated file(s) are out of date: ${stale.map((d) => d.path).join(", ")}`,
          `sddx sync --adapter ${name} --yes`,
        ),
      );
      continue;
    }
    if (manifest !== null && manifest.invocation !== ctx.invocation) {
      checks.push(
        warn(
          `adapter:${name}`,
          `generated content invokes \`${manifest.invocation}\` but policy says \`${ctx.invocation}\``,
          `sddx sync --adapter ${name} --yes`,
        ),
      );
      continue;
    }
    checks.push(
      pass(`adapter:${name}`, `up to date (${Object.keys(manifest?.files ?? {}).length} files)`),
    );
  }
  return checks;
}

/**
 * Legacy plugin state, reported and never touched.
 *
 * sddx does not remove a Claude plugin on the user's behalf: that is global
 * harness configuration, which this design deliberately puts out of reach. So
 * this check's job is to be unambiguous about what to do and in what order.
 */
function checkLegacyPlugin(root: string): Check[] {
  const findings: string[] = [];

  if (existsSync(join(root, ".claude-plugin", "marketplace.json"))) {
    findings.push(".claude-plugin/marketplace.json is still present");
  }
  const settings = join(root, ".claude", "settings.json");
  if (existsSync(settings)) {
    try {
      if (readFileSync(settings, "utf8").includes("CLAUDE_PLUGIN_ROOT")) {
        findings.push(".claude/settings.json still registers plugin-root hooks");
      }
    } catch {
      // unreadable settings are the settings check's business, not this one
    }
  }
  if (findings.length === 0) return [pass("legacy-plugin", "no legacy plugin state")];

  return [
    warn(
      "legacy-plugin",
      `${findings.join("; ")}. Running both is safe while you verify, but the duplicate hook registrations will both fire.`,
      "sddx init --adapter claude && sddx doctor   # then remove the plugin from Claude Code",
    ),
  ];
}

export function runDoctor(opts: {
  cwd: string;
  root: string | null;
  config: ResolvedConfig | null;
  adapters: Record<string, Adapter>;
  adapterContext: AdapterContext | null;
  runningVersion: string;
}): DoctorReport {
  const checks: Check[] = [checkBun(), checkGit(opts.root, opts.cwd)];

  checks.push(pass("sddx-version", opts.runningVersion));

  if (opts.root !== null) {
    const configCheck = checkConfig(opts.root);
    checks.push(configCheck);
    if (opts.config !== null && opts.adapterContext !== null && configCheck.status !== "fail") {
      checks.push(...checkRuntimeScope(opts.root, opts.config, opts.runningVersion));
      checks.push(...checkAdapters(opts.root, opts.config, opts.adapters, opts.adapterContext));
    }
    checks.push(...checkLegacyPlugin(opts.root));
  }

  return { checks, failed: checks.some((c) => c.status === "fail") };
}
