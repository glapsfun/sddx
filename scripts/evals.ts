// Entry point for `bun run evals`: headless harness sessions graded by what
// they leave behind. With no selection it only lists the catalog. See the
// "Behavior evals" section of docs/RELEASING.md.
import { join } from "node:path";
import { main } from "../evals/runner";

const checkout = new URL("..", import.meta.url).pathname;

process.exit(
  await main(
    process.argv.slice(2),
    process.env,
    { out: (l) => console.log(l), err: (l) => console.error(l) },
    { checkout, outDir: join(checkout, ".docs", "evidence", "v6-evidence") },
  ),
);
