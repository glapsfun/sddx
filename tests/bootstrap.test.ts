import { expect, test } from "bun:test";

test("bootstrap entry exits 0 with no output", async () => {
  const proc = Bun.spawn(["bun", "src/bootstrap.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await new Response(proc.stderr).text()).toBe("");
});
