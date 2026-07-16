import { expect, test } from "bun:test";

async function runsCleanly(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("");
}

test("launcher shim runs the dist bundle", async () => {
  await runsCleanly(["bin/sddx-run", "dist/bootstrap.mjs"]);
});

test("dist bundle runs under plain node (fallback path)", async () => {
  await runsCleanly(["node", "dist/bootstrap.mjs"]);
});
