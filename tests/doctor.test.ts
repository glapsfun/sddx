// `sddx doctor`. Two invariants run through every test here: it never writes,
// and every non-passing check names the command that fixes it.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { V5_MANIFEST_PATH } from "../src/lib/legacy/v5-claude";
import { fixtureRepo, writeConfig } from "./fixtures";
import { sddx } from "./helpers";
import { extractV5Fixture } from "./v5-fixture";

const CHECK_IDS = ["bun", "git-repository", "sddx-version", "project-config", "v5-leftovers"];

interface Check {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

function cli(cwd: string, ...args: string[]) {
  const r = sddx(cwd, ...args);
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function checks(cwd: string): { checks: Check[]; failed: boolean; status: number } {
  const r = cli(cwd, "doctor", "--output", "json");
  const envelope = JSON.parse(r.stdout) as { data: { checks: Check[]; failed: boolean } };
  return { ...envelope.data, status: r.status };
}

const byId = (list: Check[], id: string): Check | undefined => list.find((c) => c.id === id);

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) Object.assign(out, snapshot(abs, base));
    else out[relative(base, abs)] = readFileSync(abs, "utf8");
  }
  return out;
}

/** A repository configured for sddx 6. */
function configured(): string {
  const root = fixtureRepo();
  writeConfig(root, { interaction_mode: "human", profile: "default" });
  return root;
}

/** The settings sddx 5 merged its hook registrations into. */
const V5_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: "sddx hook tdd-gate" }] },
      ],
    },
  },
  null,
  2,
)}\n`;

describe("the full picture", () => {
  test("a healthy repository passes every check and exits 0", () => {
    const { checks: list, failed, status } = checks(configured());
    expect(failed).toBe(false);
    expect(status).toBe(0);
    for (const id of CHECK_IDS) {
      expect(byId(list, id)?.status).toBe("pass");
    }
  });

  test("every non-passing check carries an exact fix command", () => {
    // The property that makes doctor worth running, asserted across a repo
    // deliberately broken in several ways at once.
    const root = fixtureRepo();
    write(root, ".sddx/config.json", JSON.stringify({ schema_version: "0.1", nonsense_key: 1 }));
    write(root, ".claude/agents/sddx-verifier.md", "# left behind\n");
    const { checks: list } = checks(root);
    const notPassing = list.filter((c) => c.status !== "pass");
    expect(notPassing.length).toBeGreaterThan(1);
    for (const c of notPassing) {
      expect(c.fix, `check ${c.id} has no fix`).toBeTruthy();
    }
  });

  test("runs outside a git repository without crashing", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "sddx-nonrepo-"));
    const { checks: list, failed, status } = checks(notARepo);
    expect(failed).toBe(true);
    expect(status).toBe(1);
    const git = byId(list, "git-repository")!;
    expect(git.status).toBe("fail");
    expect(git.fix).toContain("git init");
  });

  test("an unconfigured repository passes: defaults apply, there is no init", () => {
    const { checks: list, status } = checks(fixtureRepo());
    expect(status).toBe(0);
    const cfg = byId(list, "project-config")!;
    expect(cfg.status).toBe("pass");
    expect(cfg.detail).toContain("defaults apply");
  });

  test("a sddx 5 repository fails, naming sddx migrate", () => {
    const { dir } = extractV5Fixture();
    const { checks: list, status } = checks(dir);
    expect(status).toBe(1);
    const cfg = byId(list, "project-config")!;
    expect(cfg.status).toBe("fail");
    expect(cfg.detail).toContain("sddx 5");
    expect(cfg.fix).toBe("sddx migrate");
  });
});

describe("read-only", () => {
  test("changes nothing, in a healthy repository or a broken one", () => {
    const broken = fixtureRepo();
    write(broken, ".sddx/config.json", JSON.stringify({ schema_version: "1.0" }));
    write(broken, ".claude/agents/sddx-verifier.md", "# left behind\n");
    write(broken, ".claude/settings.json", V5_SETTINGS);
    for (const root of [configured(), broken]) {
      const before = snapshot(root);
      cli(root, "doctor");
      expect(snapshot(root)).toEqual(before);
    }
  });
});

describe("sddx 5 integration leftovers", () => {
  test("a file at a path sddx 5 generated warns, naming sddx migrate", () => {
    const root = configured();
    write(root, ".claude/agents/sddx-verifier.md", "# hand-edited\n");

    const { checks: list, failed } = checks(root);
    expect(failed).toBe(false);
    const leftovers = byId(list, "v5-leftovers")!;
    expect(leftovers.status).toBe("warn");
    expect(leftovers.detail).toContain(".claude/");
    expect(leftovers.fix).toContain("sddx migrate");
  });

  test("sddx 5 hook registrations are reported: the plugin's would fire too", () => {
    const root = configured();
    write(root, ".claude/settings.json", V5_SETTINGS);

    const leftovers = byId(checks(root).checks, "v5-leftovers")!;
    expect(leftovers.status).toBe("warn");
    expect(leftovers.detail).toContain("hook registrations");
    expect(leftovers.detail).toContain("both would fire");
  });

  test("the sddx 5 adapter declaration is reported", () => {
    const root = configured();
    write(root, ".sddx/adapters/claude.json", "{}\n");
    const leftovers = byId(checks(root).checks, "v5-leftovers")!;
    expect(leftovers.status).toBe("warn");
    expect(leftovers.detail).toContain(".sddx/adapters/claude.json");
  });

  test("a config still naming adapters is reported as a removed key", () => {
    const root = fixtureRepo();
    writeConfig(root, { adapters: ["emacs"] });
    const cfg = byId(checks(root).checks, "project-config")!;
    expect(cfg.status).toBe("warn");
    expect(cfg.detail).toContain('"adapters" removed in sddx 6');
    expect(cfg.fix).toBe("sddx config validate");
  });

  test("no sddx 5 integration files is a pass, not a warning", () => {
    expect(byId(checks(configured()).checks, "v5-leftovers")!.status).toBe("pass");
  });

  test("detection never removes anything", () => {
    const root = configured();
    write(root, ".claude/agents/sddx-verifier.md", "# hand-edited\n");
    cli(root, "doctor");
    expect(readFileSync(join(root, ".claude/agents/sddx-verifier.md"), "utf8")).toBe(
      "# hand-edited\n",
    );
  });
});

describe("output", () => {
  test("JSON carries every check under the envelope's data key", () => {
    const r = cli(configured(), "doctor", "--output", "json");
    const envelope = JSON.parse(r.stdout) as {
      data: { checks: Check[]; failed: boolean };
      metadata: { plugin_version: string };
    };
    expect(envelope.data.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    for (const c of envelope.data.checks) {
      expect(typeof c.id).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
    expect(envelope.metadata.plugin_version).not.toBe("unknown");
  });

  test("terminal output prints the fix under each failing check", () => {
    const root = fixtureRepo();
    write(root, ".sddx/config.json", JSON.stringify({ schema_version: "1.0" }));
    const r = cli(root, "doctor");
    expect(r.status).toBe(1);
    const combined = `${r.stdout}${r.stderr}`;
    expect(combined).toContain("project-config");
    expect(combined).toContain("fix: sddx migrate");
  });
});

/**
 * Regressions from the high-effort review. doctor is documented as read-only
 * and degrading to a reportable state; these are the inputs that used to make
 * it throw a bare parse error and print no checks at all — the one command a
 * user reaches for when their setup is already broken.
 */
describe("doctor survives damaged inputs", () => {
  test("a malformed .claude/settings.json does not stop the report", () => {
    const root = configured();
    write(root, ".claude/settings.json", "oops not json\n");
    const { checks: list, status } = checks(root);
    expect(list.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(status).toBe(0);
  });

  test("a settings file holding a JSON array does not stop the report", () => {
    const root = configured();
    write(root, ".claude/settings.json", "[1, 2, 3]\n");
    expect(checks(root).checks.map((c) => c.id)).toEqual(CHECK_IDS);
  });

  test("an ownership manifest missing its files key does not crash any command", () => {
    const root = configured();
    write(root, V5_MANIFEST_PATH, '{"schema_version":"1.0"}\n');
    write(root, ".claude/agents/sddx-planner.md", "# drifted\n");

    const { checks: list } = checks(root);
    expect(byId(list, "v5-leftovers")?.status).toBe("warn");
    expect(cli(root, "migrate").status).toBe(0);
  });

  test("a truncated manifest does not crash migrate", () => {
    const root = configured();
    write(root, V5_MANIFEST_PATH, "{ truncated");
    const r = cli(root, "migrate");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("is not an object");
  });
});
