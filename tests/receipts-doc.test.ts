import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReceipt } from "../src/lib/receipt";
import { repoRoot } from "./helpers";

const doc = readFileSync(join(repoRoot, "docs", "reference", "receipts-schema.md"), "utf8");

test("the documented v5 receipt is accepted by the validator", () => {
  const json = /<!-- receipt-example: v5 -->\n```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
  expect(json).toBeDefined();
  const receipt = JSON.parse(json as string);
  expect(receipt.version).toBe(5);
  expect(validateReceipt(receipt)).toEqual([]);
});
