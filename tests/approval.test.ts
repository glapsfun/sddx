import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalPath,
  findApproval,
  mergeAssumptions,
  planHash,
  readApproval,
  writeApproval,
} from "../src/lib/approval";
import { signPayload, verifySignature } from "../src/lib/sign";
import { fixtureRepo, signingRepo } from "./fixtures";
import { goalSpec, type SpecTaskInput, sddx, writeSpec } from "./helpers";

const NAME = "2026-01-01-do-the-thing";

const TASKS: SpecTaskInput[] = [
  { id: "T1", title: "first thing", scope: ["src/a/**"] },
  { id: "T2", title: "second thing", scope: ["src/b/**"], dependsOn: ["T1"] },
];

const SPEC = (tasks: SpecTaskInput[] = TASKS, assumptions = ["sessions are server-side"]) =>
  goalSpec({ title: "do the thing", tasks, assumptions });

/** A repo holding a two-task goal spec; returns the spec's absolute path. */
function planRepo(cwd = fixtureRepo()): { cwd: string; spec: string } {
  return { cwd, spec: join(cwd, writeSpec(cwd, NAME, SPEC())) };
}

const edit = (path: string, from: string, to: string): void => {
  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
};

describe("planHash", () => {
  test("is stable across recomputation", () => {
    const { spec } = planRepo();
    expect(planHash(spec).hash).toBe(planHash(spec).hash);
  });

  test("is a lowercase 64-char hex digest", () => {
    const { spec } = planRepo();
    expect(planHash(spec).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reordering tasks in the spec DOES invalidate the hash", () => {
    // Deliberate: the spec contributes its raw bytes, so any edit, including a
    // semantically-neutral reorder, invalidates approval. A canonical semantic
    // hash would have to enumerate every meaningful field correctly, and missing
    // one (e.g. retry.max_attempts) would leave an edit silently approved. False
    // invalidation costs a re-approval; false validation is unbounded.
    const { spec } = planRepo();
    const first = planHash(spec).hash;
    const [t1, t2] = TASKS as [SpecTaskInput, SpecTaskInput];
    writeFileSync(spec, SPEC([t2, t1]));
    expect(planHash(spec).hash).not.toBe(first);
  });

  test("changes when a field the plan gate reads is edited", () => {
    // guards the hole a semantic hash would open
    const { spec } = planRepo();
    const before = planHash(spec).hash;
    const [t1, t2] = TASKS as [SpecTaskInput, SpecTaskInput];
    writeFileSync(spec, SPEC([{ ...t1, extra: "retry:\n  max_attempts: 50" }, t2]));
    expect(planHash(spec).hash).not.toBe(before);
  });

  test("changes when the goal title changes", () => {
    const { spec } = planRepo();
    const before = planHash(spec).hash;
    edit(spec, "# do the thing", "# do another thing");
    expect(planHash(spec).hash).not.toBe(before);
  });

  test("changes when any task's oracle changes", () => {
    const { spec } = planRepo();
    const before = planHash(spec).hash;
    edit(spec, '"test -f T2.done"', '"test -f T2.done && true"');
    expect(planHash(spec).hash).not.toBe(before);
  });

  test("changes when an edge changes", () => {
    const { spec } = planRepo();
    const before = planHash(spec).hash;
    edit(spec, "depends_on: [T1]\n", "");
    expect(planHash(spec).hash).not.toBe(before);
  });

  // The Design section is part of the spec file, so it rides the byte hash that
  // already covers the tasks. These assert that guarantee holds rather than
  // introducing a second digest: a design-specific digest would need its own
  // canonicalization, and every canonicalization layer is a surface on which
  // two different designs can collide to one value.
  describe("covers the Design section", () => {
    test("an unchanged spec re-digests byte-identically on a later read", () => {
      const { spec } = planRepo();
      const first = planHash(spec).hash;
      // re-read from disk, as a separate process would
      writeFileSync(spec, readFileSync(spec, "utf8"));
      expect(planHash(spec).hash).toBe(first);
    });

    test("editing a recorded acceptance criterion invalidates the hash", () => {
      const { spec } = planRepo();
      const before = planHash(spec).hash;
      edit(spec, "- every task's oracle passes", "- most tasks' oracles pass");
      expect(planHash(spec).hash).not.toBe(before);
    });

    test("editing a recorded assumption invalidates the hash", () => {
      const { spec } = planRepo();
      const before = planHash(spec).hash;
      edit(spec, "sessions are server-side", "the client stores sessions");
      expect(planHash(spec).hash).not.toBe(before);
    });

    test("a cosmetic reorder also invalidates: the accepted cost of no canonicalization", () => {
      const cwd = fixtureRepo();
      const spec = join(cwd, writeSpec(cwd, NAME, SPEC(TASKS, ["first", "second"])));
      const before = planHash(spec).hash;
      edit(spec, "- first\n- second\n", "- second\n- first\n");
      expect(planHash(spec).hash).not.toBe(before);
    });
  });

  test("reports errors instead of hashing an unreadable plan", () => {
    const cwd = fixtureRepo();
    const r = planHash(join(cwd, ".sddx", "specs", "nope.md"));
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.hash).toBe("");
  });
});

describe("approval tokens", () => {
  test("are content-addressed by the plan hash", () => {
    const { cwd, spec } = planRepo();
    const { hash } = planHash(spec);
    writeApproval(cwd, { plan_sha256: hash, mode: "human" });
    expect(approvalPath(cwd, hash)).toBe(join(cwd, ".sddx", "approvals", `${hash}.json`));
    expect(readApproval(cwd, hash)?.plan_sha256).toBe(hash);
  });

  test("a written token is found for its plan", () => {
    const { cwd, spec } = planRepo();
    writeApproval(cwd, { plan_sha256: planHash(spec).hash, mode: "human" });
    const found = findApproval(cwd, spec);
    expect(found.ok).toBe(true);
    expect(found.approval?.mode).toBe("human");
  });

  test("an absent token is reported as missing, not as an error", () => {
    const { cwd, spec } = planRepo();
    const found = findApproval(cwd, spec);
    expect(found.ok).toBe(false);
    expect(found.reason).toContain("no approval");
    expect(found.approval).toBeUndefined();
  });

  test("editing a task after approval invalidates the token", () => {
    const { cwd, spec } = planRepo();
    writeApproval(cwd, { plan_sha256: planHash(spec).hash, mode: "human" });
    expect(findApproval(cwd, spec).ok).toBe(true);

    edit(spec, "### T1 first thing", "### T1 first thing, edited");
    const after = findApproval(cwd, spec);
    expect(after.ok).toBe(false);
    expect(after.reason).toContain("no approval");
  });

  test("a regenerated byte-identical plan reuses its approval", () => {
    const { cwd, spec } = planRepo();
    const original = readFileSync(spec, "utf8");
    writeApproval(cwd, { plan_sha256: planHash(spec).hash, mode: "human" });

    writeFileSync(spec, SPEC([{ id: "T1", title: "something else entirely" }]));
    expect(findApproval(cwd, spec).ok).toBe(false);
    writeFileSync(spec, original);
    expect(findApproval(cwd, spec).ok).toBe(true);
  });

  test("an unreadable token is treated as absent, never as approval", () => {
    const { cwd, spec } = planRepo();
    const { hash } = planHash(spec);
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(approvalPath(cwd, hash), "{not json");
    expect(findApproval(cwd, spec).ok).toBe(false);
  });

  test("a token whose recorded hash disagrees with its filename is rejected", () => {
    const { cwd, spec } = planRepo();
    const { hash } = planHash(spec);
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(
      approvalPath(cwd, hash),
      JSON.stringify({ plan_sha256: "0".repeat(64), mode: "human", at: new Date().toISOString() }),
    );
    expect(findApproval(cwd, spec).ok).toBe(false);
  });

  test("a spec that does not parse is never approved, so no token exists for its bytes", () => {
    // planHash no longer validates (any bytes hash), so the refusal lives in
    // `plan approve`. Hashing an invalid spec must not be mistaken for approving it.
    const cwd = fixtureRepo();
    const rel = writeSpec(cwd, NAME, "# do the thing\n\nno design section\n");
    const r = sddx(cwd, "plan", "approve", rel);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("## Design");
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);
    expect(findApproval(cwd, join(cwd, rel)).ok).toBe(false);
  });
});

describe("signing namespaces", () => {
  test("a receipt signature does not verify as an approval signature", () => {
    const cwd = signingRepo();
    const sig = signPayload(cwd, "payload", "sddx-receipt");
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(verifySignature(cwd, "payload", sig, "sddx-receipt")).toBe("valid");
    expect(verifySignature(cwd, "payload", sig, "sddx-approval")).toBe("invalid");
  });

  test("an approval signature does not verify as a receipt signature", () => {
    const cwd = signingRepo();
    const sig = signPayload(cwd, "payload", "sddx-approval");
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(verifySignature(cwd, "payload", sig, "sddx-approval")).toBe("valid");
    expect(verifySignature(cwd, "payload", sig, "sddx-receipt")).toBe("invalid");
  });

  test("the receipt namespace remains the default", () => {
    const cwd = signingRepo();
    const sig = signPayload(cwd, "payload");
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(verifySignature(cwd, "payload", sig)).toBe("valid");
  });
});

describe("token signing is best-effort", () => {
  test("no signing key configured yields an unsigned token, not an error", () => {
    const { cwd, spec } = planRepo();
    const token = writeApproval(cwd, { plan_sha256: planHash(spec).hash, mode: "human" });
    expect(token.signature).toBeUndefined();
    expect(findApproval(cwd, spec).ok).toBe(true);
  });

  test("a configured key produces a signed token that verifies", () => {
    const { cwd, spec } = planRepo(signingRepo());
    const { hash } = planHash(spec);
    const token = writeApproval(cwd, { plan_sha256: hash, mode: "human" });
    expect(token.signature).toBeDefined();
    expect(token.signer).toBeDefined();
    if (!token.signature || !token.signer) return;
    expect(
      verifySignature(
        cwd,
        hash,
        { signature: token.signature, signer: token.signer },
        "sddx-approval",
      ),
    ).toBe("valid");
  });
});

describe("goal-level assumptions denormalize into every task", () => {
  test("a cross-cutting assumption reaches each task, task ones preserved", () => {
    const goalLevel = ["the project uses Vite"];
    const taskA = { assumptions: ["a-only"] };
    const taskB = { assumptions: [] as string[] };
    expect(mergeAssumptions(goalLevel, taskA.assumptions)).toEqual([
      "the project uses Vite",
      "a-only",
    ]);
    expect(mergeAssumptions(goalLevel, taskB.assumptions)).toEqual(["the project uses Vite"]);
  });

  test("a task repeating a goal assumption is not duplicated", () => {
    expect(mergeAssumptions(["shared"], ["shared", "mine"])).toEqual(["shared", "mine"]);
  });

  test("no goal assumptions leaves task assumptions untouched", () => {
    expect(mergeAssumptions([], ["mine"])).toEqual(["mine"]);
    expect(mergeAssumptions([], [])).toEqual([]);
  });
});
