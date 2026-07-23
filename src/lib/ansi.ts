/** Minimal dependency-free ANSI helpers — no chalk/picocolors, per sddx's
 * zero-footprint install principle (G6). Only the 8 basic SGR codes are used. */

const CODES = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

export type AnsiColor = keyof typeof CODES;

export function colorEnabled(
  opts: { noColor?: boolean; stream?: { isTTY?: boolean } } = {},
): boolean {
  if (opts.noColor) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  const stream = opts.stream ?? process.stdout;
  return Boolean(stream.isTTY);
}

export function paint(text: string, color: AnsiColor, enabled: boolean): string {
  if (!enabled) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}
