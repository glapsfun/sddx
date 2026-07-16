export {};

const result = await Bun.build({
  entrypoints: ["src/bootstrap.ts", "src/cli.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  naming: "[name].mjs",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
