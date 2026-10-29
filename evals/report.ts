// The run's report, as Markdown for a person and JSON for a later comparison.
// A pass rate counts passes against failures; errors are reported apart, since
// they say the session broke, not how the agent behaved.
import type { Harness, HarnessInfo, SessionResult } from "./types";

export interface RunMeta {
  started: Date;
  commit: string;
  dirty: boolean;
  harnesses: Partial<Record<Harness, HarnessInfo>>;
}

export interface Row {
  scenario: string;
  harness: Harness;
  runs: number;
  pass: number;
  fail: number;
  error: number;
  /** Passes over passes plus failures, null when every session errored. */
  rate: number | null;
}

export function summarize(results: SessionResult[]): Row[] {
  const rows = new Map<string, Row>();
  for (const r of results) {
    const key = `${r.scenario}\0${r.harness}`;
    const row = rows.get(key) ?? {
      scenario: r.scenario,
      harness: r.harness,
      runs: 0,
      pass: 0,
      fail: 0,
      error: 0,
      rate: null,
    };
    row.runs++;
    row[r.outcome]++;
    row.rate = row.pass + row.fail === 0 ? null : row.pass / (row.pass + row.fail);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Replaces each fixture path with `<fixture>` and each home with `~`, longest first. */
export function stripper(homes: string[], fixtures: string[]): (text: string) => string {
  const pairs = [
    ...fixtures.map((p) => [p, "<fixture>"] as const),
    ...homes.map((p) => [p, "~"] as const),
  ]
    .filter(([p]) => p.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  return (text) => pairs.reduce((t, [from, to]) => t.replaceAll(from, to), text);
}

const pct = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");

export function renderMarkdown(meta: RunMeta, results: SessionResult[]): string {
  const lines = [
    `# Behavior evals, ${stamp(meta.started)} UTC`,
    "",
    `- Plugin commit: \`${meta.commit}\`${meta.dirty ? " with uncommitted changes" : ""}`,
  ];
  for (const [h, info] of Object.entries(meta.harnesses)) {
    lines.push(`- ${h}: ${info.version}, model ${info.model}`);
  }
  const tokens = new Map<string, { input: number; output: number }>();
  for (const r of results) {
    if (!r.tokens) continue;
    const t = tokens.get(r.harness) ?? { input: 0, output: 0 };
    t.input += r.tokens.input;
    t.output += r.tokens.output;
    tokens.set(r.harness, t);
  }
  for (const [h, t] of tokens) {
    lines.push(
      `- ${h} tokens: ${t.input.toLocaleString("en")} in, ${t.output.toLocaleString("en")} out`,
    );
  }
  lines.push(
    "",
    "## Results",
    "",
    "| Scenario | Harness | Pass | Fail | Error | Pass rate |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const r of summarize(results)) {
    lines.push(
      `| ${r.scenario} | ${r.harness} | ${r.pass}/${r.runs} | ${r.fail}/${r.runs} | ${r.error}/${r.runs} | ${pct(r.rate)} |`,
    );
  }
  const notPassed = results.filter((r) => r.outcome !== "pass");
  if (notPassed.length > 0) lines.push("", "## Failures and errors");
  for (const r of notPassed) {
    lines.push("", `### ${r.scenario}, ${r.harness}, run ${r.run}: ${r.outcome}`, "");
    for (const reason of r.reasons) lines.push(`- ${reason}`);
    if (r.commands.length > 0) lines.push("", "sddx commands:", "", "```sh", ...r.commands, "```");
    if (r.reply.trim() !== "") {
      lines.push(
        "",
        "Final reply:",
        "",
        ...r.reply
          .trim()
          .split("\n")
          .map((l) => `> ${l}`),
      );
    }
  }
  return `${lines.map((l) => l.trimEnd()).join("\n")}\n`;
}

export function renderJson(meta: RunMeta, results: SessionResult[]): string {
  return `${JSON.stringify(
    {
      started: meta.started.toISOString(),
      commit: meta.commit,
      dirty: meta.dirty,
      harnesses: meta.harnesses,
      summary: summarize(results),
      sessions: results,
    },
    null,
    2,
  )}\n`;
}
