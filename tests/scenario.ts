// Links a test to an OpenSpec scenario. scripts/spec-coverage.ts finds these
// calls by their literal arguments, so both must stay plain string literals.
import { test } from "bun:test";

type TestFn = Parameters<typeof test>[1];
type TestOptions = Parameters<typeof test>[2];

export function scenario(
  capability: string,
  name: string,
  fn: TestFn,
  options?: TestOptions,
): void {
  test(`[${capability}] ${name}`, fn, options);
}
