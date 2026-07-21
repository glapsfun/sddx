import { spawnSync } from "node:child_process";
import { readConfig } from "./config";
import { remoteUrl } from "./git";

export type PrHostName = "gh" | "glab";

export interface OpenPrOptions {
  branch: string;
  title: string;
  body: string;
}

export interface AuthStatus {
  ok: boolean;
  message: string;
}

export interface PrHostBackend {
  name: PrHostName;
  /** The authenticated identity's login/username, or null if it can't be determined. */
  identity(cwd: string): string | null;
  authStatus(cwd: string): AuthStatus;
  /** Returns the opened PR/MR's URL. */
  openPr(cwd: string, opts: OpenPrOptions): string;
  /** The open PR/MR for `branch`, or null if none exists. Callers that need to
   * distinguish "none exists" from "couldn't check" should call `authStatus`
   * first — this never throws on a plain not-found. */
  findPr(cwd: string, branch: string): { url: string } | null;
  /** Merges the open PR/MR for `branch`; returns the host CLI's report line. */
  mergePr(cwd: string, branch: string): string;
}

// explicit `env` matters: without it, some runtimes resolve the executable
// against a PATH snapshot taken at process start rather than the live value
function run(cli: string, args: string[], cwd: string) {
  return spawnSync(cli, args, { cwd, encoding: "utf8", env: process.env });
}

export const ghBackend: PrHostBackend = {
  name: "gh",
  identity(cwd) {
    const r = run("gh", ["api", "user", "--jq", ".login"], cwd);
    return r.status === 0 ? r.stdout.trim() : null;
  },
  authStatus(cwd) {
    // one spawn answers both questions: `.error` is set on ENOENT (missing
    // CLI) regardless of the subcommand args, so there's no need for a
    // separate `--version` probe before the real `auth status` call
    const r = run("gh", ["auth", "status"], cwd);
    if (r.error) {
      return { ok: false, message: "gh CLI not found — install it from https://cli.github.com" };
    }
    return { ok: r.status === 0, message: ((r.stderr ?? "") + (r.stdout ?? "")).trim() };
  },
  openPr(cwd, { branch, title, body }) {
    const r = run("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], cwd);
    if (r.status !== 0) {
      throw new Error(`gh pr create failed: ${(r.stderr ?? "").trim()}`);
    }
    return r.stdout.trim();
  },
  findPr(cwd, branch) {
    const r = run("gh", ["pr", "view", branch, "--json", "url"], cwd);
    if (r.status !== 0) return null;
    try {
      return { url: (JSON.parse(r.stdout) as { url: string }).url };
    } catch {
      return null;
    }
  },
  mergePr(cwd, branch) {
    const r = run("gh", ["pr", "merge", branch, "--merge"], cwd);
    if (r.status !== 0) {
      throw new Error(`gh pr merge failed: ${(r.stderr ?? "").trim()}`);
    }
    return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  },
};

export const glabBackend: PrHostBackend = {
  name: "glab",
  identity(cwd) {
    const r = run("glab", ["api", "user", "--jq", ".username"], cwd);
    return r.status === 0 ? r.stdout.trim() : null;
  },
  authStatus(cwd) {
    const r = run("glab", ["auth", "status"], cwd);
    if (r.error) {
      return {
        ok: false,
        message: "glab CLI not found — install it from https://gitlab.com/gitlab-org/cli",
      };
    }
    return { ok: r.status === 0, message: ((r.stderr ?? "") + (r.stdout ?? "")).trim() };
  },
  openPr(cwd, { branch, title, body }) {
    const r = run(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
      cwd,
    );
    if (r.status !== 0) {
      throw new Error(`glab mr create failed: ${(r.stderr ?? "").trim()}`);
    }
    return r.stdout.trim();
  },
  findPr(cwd, branch) {
    const r = run("glab", ["mr", "view", branch], cwd);
    if (r.status !== 0) return null;
    const m = /(https?:\/\/\S+)/.exec(r.stdout);
    return { url: m ? m[1] : r.stdout.trim() };
  },
  mergePr(cwd, branch) {
    const r = run("glab", ["mr", "merge", branch, "--yes"], cwd);
    if (r.status !== 0) {
      throw new Error(`glab mr merge failed: ${(r.stderr ?? "").trim()}`);
    }
    return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  },
};

const BACKENDS: Record<PrHostName, PrHostBackend> = { gh: ghBackend, glab: glabBackend };

const HOST_PATTERNS: Array<{ pattern: RegExp; host: PrHostName }> = [
  { pattern: /github\.com/, host: "gh" },
  { pattern: /gitlab\.com/, host: "glab" },
];

/**
 * Resolution order: `userConfig.pr_host` override, then the `origin` remote's
 * URL matched against known host patterns. Refuses rather than guessing when
 * neither yields an unambiguous backend.
 */
export function resolveBackend(cwd: string): PrHostBackend {
  const configured = readConfig(cwd).pr_host;
  if (configured) {
    const backend = BACKENDS[configured];
    if (!backend) {
      throw new Error(`userConfig.pr_host is "${configured}" — must be "gh" or "glab"`);
    }
    return backend;
  }

  const url = remoteUrl(cwd, "origin");
  if (url) {
    for (const { pattern, host } of HOST_PATTERNS) {
      if (pattern.test(url)) return BACKENDS[host];
    }
  }
  throw new Error(
    'cannot determine PR host from the "origin" remote — set userConfig.pr_host to "gh" or "glab"',
  );
}
