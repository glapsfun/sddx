// The interactive half of `sddx init`.
//
// This module collects and validates choices. It does not mutate anything, and
// it must not grow the ability to: every write goes through the bootstrap core,
// which the flag path calls with the identical argument object. A prompt-only
// code path would be a second implementation of the thing that changes the
// user's repository, and the two would drift.
//
// `@clack/prompts` is a devDependency bundled at build time, so the published
// package still declares no runtime dependencies. It is loaded through a
// dynamic import behind a TTY check so non-interactive runs — and the hook hot
// path, which shares this bundle — never pay to evaluate it.
import {
  CONFIG_KEYS,
  type InteractionMode,
  type PackageManager,
  type RuntimeScope,
} from "./config";
import type { InitOptions } from "./init";

/** True only when a human can actually answer. */
export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

/** The user pressed Ctrl-C. Treated exactly like declining the confirmation. */
export class InitCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "InitCancelled";
  }
}

const describe = (key: string): string => CONFIG_KEYS.find((k) => k.key === key)?.description ?? "";

/**
 * Asks the four init questions. The change confirmation is deliberately NOT
 * here: it is asked after the plan is computed and rendered, so what the user
 * approves is the actual file list rather than a promise about one.
 */
export async function promptInitOptions(
  defaults: Partial<InitOptions>,
  knownAdapters: readonly string[],
): Promise<InitOptions> {
  const p = await import("@clack/prompts");

  const cancelled = (v: unknown): boolean => p.isCancel(v);
  const guard = <T>(v: T | symbol): T => {
    if (cancelled(v)) throw new InitCancelled();
    return v as T;
  };

  p.intro("sddx init");

  const runtimeScope = guard(
    await p.select({
      message: "How should this project invoke sddx?",
      initialValue: defaults.runtimeScope ?? "global",
      options: [
        {
          value: "global" as RuntimeScope,
          label: "Global",
          hint: "an `sddx` on PATH — simplest",
        },
        {
          value: "project" as RuntimeScope,
          label: "Project-pinned",
          hint: "a lockfile-backed dependency — reproducible across the team",
        },
      ],
    }),
  );

  const packageManager =
    runtimeScope === "project"
      ? guard(
          await p.select({
            message: "Which package manager runs the project-local binary?",
            initialValue: defaults.packageManager ?? "npm",
            options: [
              { value: "npm" as PackageManager, label: "npm" },
              { value: "bun" as PackageManager, label: "bun" },
            ],
          }),
        )
      : (defaults.packageManager ?? "npm");

  const adapters = guard(
    await p.multiselect({
      message: "Which project adapters should sddx install?",
      required: false,
      initialValues: defaults.adapters ?? [],
      options: knownAdapters.map((name) => ({
        value: name,
        label: name,
        hint: name === "claude" ? "skills, agents, and the TDD-gate hooks" : "",
      })),
    }),
  );

  const interactionMode = guard(
    await p.select({
      message: "Interaction mode",
      initialValue: defaults.interactionMode ?? "human",
      options: [
        {
          value: "human" as InteractionMode,
          label: "human",
          hint: "one question round, then plan approval",
        },
        {
          value: "auto" as InteractionMode,
          label: "auto",
          hint: "unattended up to the run branch; refuses at any autonomy bound",
        },
      ],
    }),
  );
  // The description lives in one place — the config schema — so the prompt and
  // `sddx config show` can never describe the same key differently.
  p.note(describe("interaction_mode"), "interaction_mode");

  return { runtimeScope, packageManager, adapters: adapters as string[], interactionMode };
}

/** Confirms the rendered change plan. Declining is a clean, zero-mutation exit. */
export async function confirmPlan(rendered: string): Promise<boolean> {
  const p = await import("@clack/prompts");
  p.note(rendered, "planned changes");
  const answer = await p.confirm({ message: "Apply these changes?", initialValue: true });
  if (p.isCancel(answer)) return false;
  return answer === true;
}

export async function outroSuccess(message: string): Promise<void> {
  const p = await import("@clack/prompts");
  p.outro(message);
}
