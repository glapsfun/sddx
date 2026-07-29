// How generated adapter content invokes sddx.
//
// The single most important property here: the invocation is a function of the
// repository's COMMITTED policy, never of the installing machine. Two
// developers running `sddx init` against the same `.sddx/config.json` must
// generate byte-identical files, or every install churns the diff and the
// generated tree stops being reviewable.
//
// The second property: the invocation is a COMMAND, never a path. Nothing
// generated may reference a bundle file, a launcher script, or a plugin root —
// those are package-manager-owned locations that move between installs, and a
// generated file that hard-codes one breaks the next time the package updates.
import type { PackageManager, RuntimeScope } from "./config";

/**
 * The verified no-install local execution form for each package manager.
 *
 * "Verified" is literal: each was executed against a project with a local
 * binary present and absent. Both forms run the local binary when it exists and
 * fail without reaching the registry when it does not — which is what makes
 * them safe to embed in content that runs on every session start.
 *
 * `npm exec --offline --no --` rather than `npx --no-install`: the latter still
 * queries the registry when the binary is missing (a 404 round trip), which
 * would put a network call on sddx's hot path in exactly the broken-install
 * case where a user least wants one. `--offline` forces npm's cache to
 * `only-if-cached`, so the miss is local.
 */
const LOCAL_EXEC: Record<PackageManager, readonly string[]> = {
  npm: ["npm", "exec", "--offline", "--no", "--", "sddx"],
  bun: ["bunx", "--no-install", "sddx"],
};

/**
 * The argv prefix that runs sddx under the given policy. Arguments are appended
 * after it: `[...invocation, "board"]`.
 */
export function sddxInvocation(scope: RuntimeScope, pm: PackageManager): string[] {
  return scope === "global" ? ["sddx"] : [...LOCAL_EXEC[pm]];
}

/** The invocation as it appears inside generated text. */
export function sddxCommand(scope: RuntimeScope, pm: PackageManager): string {
  return sddxInvocation(scope, pm).join(" ");
}

/**
 * The remediation a user needs when they invoked the wrong binary.
 *
 * A global `sddx` running against a project-pinned repository must never
 * silently re-execute the project's own code — that would let a repository
 * choose which code a user's global command runs. It says so instead, and says
 * exactly what to type.
 */
export function pinnedRuntimeAdvice(pm: PackageManager, args: string[] = []): string {
  const cmd = [...LOCAL_EXEC[pm], ...args].join(" ");
  return `this repository pins its sddx runtime (runtime_scope: project). Run: ${cmd}`;
}
