// Scenario-to-test traceability: every `#### Scenario:` in an OpenSpec spec must
// be named by at least one `scenario("<capability>", "<name>", …)` call under
// tests/, and every such call must name a scenario that exists. A spec scenario
// nobody tests is a promise with no evidence; a link to a scenario that was
// renamed or removed is evidence for nothing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Scenario {
  capability: string;
  name: string;
  file: string;
  line: number;
}

export interface Link {
  capability: string;
  name: string;
  file: string;
  line: number;
}

export interface CoverageReport {
  scenarios: Scenario[];
  links: Link[];
  unlinked: Scenario[];
  dangling: Link[];
}

const key = (capability: string, name: string): string => `${capability}\0${name}`;

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}

/** Spec files under `openspec/specs/` and every active (unarchived) change. */
export function specFiles(root: string): string[] {
  const isSpec = (p: string): boolean => p.endsWith(`${sep}spec.md`);
  const files = walk(join(root, "openspec", "specs"), isSpec);
  const changes = join(root, "openspec", "changes");
  if (existsSync(changes)) {
    for (const name of readdirSync(changes).sort()) {
      if (name === "archive") continue;
      files.push(...walk(join(changes, name, "specs"), isSpec));
    }
  }
  return files;
}

/** `specs/<capability>/spec.md` → `<capability>`, preserving nested paths. */
export function capabilityOf(specFile: string): string {
  const parts = specFile.split(sep);
  const at = parts.lastIndexOf("specs");
  return parts.slice(at + 1, -1).join("/");
}

export function collectScenarios(root: string, files: string[]): Scenario[] {
  const out: Scenario[] = [];
  for (const file of files) {
    const capability = capabilityOf(file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      const m = /^####\s+Scenario:\s*(.+?)\s*$/.exec(text);
      if (m?.[1]) out.push({ capability, name: m[1], file: relative(root, file), line: i + 1 });
    });
  }
  return out;
}

const LINK_RE = /\bscenario\(\s*"([^"\\]+)"\s*,\s*"([^"\\]+)"/g;

export function collectLinks(root: string, testsDir: string): Link[] {
  const files = walk(testsDir, (p) => /\.test\.ts$/.test(p));
  const out: Link[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    LINK_RE.lastIndex = 0;
    for (let m = LINK_RE.exec(text); m !== null; m = LINK_RE.exec(text)) {
      const [, capability = "", name = ""] = m;
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ capability, name, file: relative(root, file), line });
    }
  }
  return out;
}

export function coverage(scenarios: Scenario[], links: Link[]): CoverageReport {
  const known = new Set(scenarios.map((s) => key(s.capability, s.name)));
  const linked = new Set(links.map((l) => key(l.capability, l.name)));
  return {
    scenarios,
    links,
    unlinked: scenarios.filter((s) => !linked.has(key(s.capability, s.name))),
    dangling: links.filter((l) => !known.has(key(l.capability, l.name))),
  };
}

export function checkCoverage(root: string, testsDir = join(root, "tests")): CoverageReport {
  return coverage(collectScenarios(root, specFiles(root)), collectLinks(root, testsDir));
}

export function renderReport(r: CoverageReport): string {
  const lines = [
    `spec-coverage: ${r.scenarios.length} scenario(s), ${r.links.length} link(s), ` +
      `${r.unlinked.length} unlinked, ${r.dangling.length} dangling`,
  ];
  for (const s of r.unlinked) {
    lines.push(`  unlinked  [${s.capability}] ${s.name}  (${s.file}:${s.line})`);
  }
  for (const l of r.dangling) {
    lines.push(`  dangling  [${l.capability}] ${l.name}  (${l.file}:${l.line})`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const root = process.cwd();
  const report = checkCoverage(root);
  // openspec/ is private planning state, absent from clones and CI. `--if-present`
  // makes that an explicit skip; without the flag a missing spec set still fails.
  if (report.scenarios.length === 0 && process.argv.includes("--if-present")) {
    console.log("spec-coverage: no openspec/ specs in this checkout, skipped");
    process.exit(0);
  }
  console.log(renderReport(report));
  if (report.scenarios.length === 0) {
    console.error("spec-coverage: no spec scenarios found under openspec/");
    process.exit(1);
  }
  process.exit(report.unlinked.length + report.dangling.length > 0 ? 1 : 0);
}
