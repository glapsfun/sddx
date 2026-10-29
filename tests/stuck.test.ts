// Stuck detection lives in `sddx verify`: consecutive verify failures with an
// identical fingerprint (proof half, exit code, oracle output) count up to
// `stuck_threshold`. The board side is covered in board.test.ts and
// lifecycle.test.ts; this file covers the counter itself and the stop gate.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopGate } from "../src/lib/stopgate";
import { fixtureRepo } from "./fixtures";
import { createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";

type Stuck = { fingerprint: string; count: number } | undefined;
const stuckOf = (cwd: string): Stuck => readTaskState(cwd, "T1").stuck as Stuck;

/** T1's oracle prints msg.txt, so a test controls whether two failures are identical. */
function repoWithStartedTask(): { cwd: string; wt: string } {
  const cwd = fixtureRepo();
  createRun(cwd, {
    tasks: [
      {
        id: "T1",
        run: "cat msg.txt 2>/dev/null; test -f T1.done",
        scope: [doneFile("T1"), "msg.txt"],
      },
    ],
  });
  return { cwd, wt: startTask(cwd, "T1") };
}

describe("stuck tracking", () => {
  test("three identical failures set stuck; a different failure resets; a pass clears", () => {
    const { cwd, wt } = repoWithStartedTask();
    writeFileSync(join(wt, "msg.txt"), "FAIL same assertion\n");
    for (let i = 1; i <= 3; i += 1) {
      const r = sddx(cwd, "verify", "T1", "--output", "json");
      expect(r.status).toBe(1);
      expect(stuckOf(cwd)?.count).toBe(i);
      expect(JSON.parse(r.stdout).data.stuck).toBe(i === 3);
    }

    writeFileSync(join(wt, "msg.txt"), "FAIL a different assertion\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(1);
    expect(stuckOf(cwd)?.count).toBe(1);

    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(stuckOf(cwd)).toBeUndefined();
    expect(readTaskState(cwd, "T1").phase).toBe("IN_REVIEW");
  });

  test("stop gate allows stopping a stuck task with an escalation note", () => {
    const { cwd, wt } = repoWithStartedTask();
    // below the threshold, an unfinished task blocks the stop
    expect(stopGate({ cwd: wt }).block).toBe(true);
    for (let i = 0; i < 3; i += 1) sddx(cwd, "verify", "T1");
    const d = stopGate({ cwd: wt });
    expect(d.block).toBe(false);
    expect(d.note).toContain("T1");
    expect(d.note).toContain("stuck");
  });
});
