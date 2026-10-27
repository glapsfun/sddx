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
import { CONFIG_SCHEMA_VERSION, validateConfigObject } from "./config";
import {
  readV5Manifest,
  unmergeV5Settings,
  V5_DECLARATION_PATH,
  V5_OWNED,
  V5_SETTINGS_PATH,
  v5Ownership,
} from "./legacy/v5-claude";

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
    return pass(
      "project-config",
      "no .sddx/config.json; defaults apply until the first plan start",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(
      "project-config",
      `.sddx/config.json is not valid JSON: ${(e as Error).message}`,
      "fix the JSON by hand, then: sddx config validate",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(
      "project-config",
      ".sddx/config.json is not a JSON object",
      "fix it by hand, then: sddx config validate",
    );
  }
  const version = (parsed as { schema_version?: unknown }).schema_version;
  if (typeof version === "string" && version.startsWith("1.")) {
    return fail(
      "project-config",
      `.sddx/config.json was written by sddx 5 (${version})`,
      "sddx migrate",
    );
  }
  const warnings = validateConfigObject(parsed as Record<string, unknown>);
  if (warnings.length > 0) {
    return warn("project-config", warnings.join("; "), "sddx config validate");
  }
  return pass("project-config", `schema_version ${CONFIG_SCHEMA_VERSION}`);
}

/** sddx 5 generated `.claude/` content or registered hooks; the plugin replaces both. */
function checkV5Leftovers(root: string): Check {
  const findings: string[] = [];
  const manifest = readV5Manifest(root);
  const owned = Object.keys(V5_OWNED).filter((p) => v5Ownership(root, p, manifest) !== "absent");
  if (owned.length > 0) findings.push(`${owned.length} sddx 5 file(s) under .claude/`);
  if (existsSync(join(root, V5_DECLARATION_PATH))) findings.push(V5_DECLARATION_PATH);
  const settings = join(root, V5_SETTINGS_PATH);
  if (existsSync(settings)) {
    try {
      if (unmergeV5Settings(readFileSync(settings, "utf8")).removed > 0) {
        findings.push(`sddx 5 hook registrations in ${V5_SETTINGS_PATH}`);
      }
    } catch {
      // unreadable settings are not this check's to diagnose
    }
  }
  if (findings.length === 0) return pass("v5-leftovers", "no sddx 5 integration files");
  return warn(
    "v5-leftovers",
    `${findings.join("; ")}; the sddx plugin replaces them and both would fire`,
    "sddx migrate   # preview, then: sddx migrate --yes",
  );
}

export function runDoctor(opts: {
  cwd: string;
  root: string | null;
  runningVersion: string;
}): DoctorReport {
  const checks: Check[] = [checkBun(), checkGit(opts.root, opts.cwd)];
  checks.push(pass("sddx-version", opts.runningVersion));
  if (opts.root !== null) {
    checks.push(checkConfig(opts.root));
    checks.push(checkV5Leftovers(opts.root));
  }
  return { checks, failed: checks.some((c) => c.status === "fail") };
}
