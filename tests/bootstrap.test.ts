import { test } from "bun:test";
import { runsCleanly } from "./helpers";

test("bootstrap entry exits 0 with no output", async () => {
  await runsCleanly(["bun", "src/bootstrap.ts"]);
});
