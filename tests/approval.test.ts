import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { fixtureRepo } from "./fixtures";
import { GRAPH_HEADER } from "./helpers";

const SPEC = (task: string) => `task: ${task}
success_criteria:
  - "it works"
oracle:
  type: command
  run: "true"
`;

/** A repo with a two-node graph and its spec drafts under .sddx/drafts/. */
function planRepo(): { cwd: string; graph: string } {
  const cwd = fixtureRepo();
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, "a.yaml"), SPEC("first thing"));
  writeFileSync(join(drafts, "b.yaml"), SPEC("second thing"));
  const graph = join(drafts, "graph.yaml");
  writeFileSync(
    graph,
    `${GRAPH_HEADER}goal: do the thing
tasks:
  - alias: alpha
    spec: a.yaml
  - alias: beta
    spec: b.yaml
    depends_on: alpha
`,
  );
  return { cwd, graph };
}

describe("planHash", () => {
  test("is stable across recomputation", () => {
    const { graph } = planRepo();
    expect(planHash(graph).hash).toBe(planHash(graph).hash);
  });

  test("is a lowercase 64-char hex digest", () => {
    const { graph } = planRepo();
    expect(planHash(graph).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is independent of the order specs are enumerated on disk", () => {
    const { cwd, graph } = planRepo();
    const first = planHash(graph).hash;
    // Rewrite both spec files in the opposite order so directory mtime/readdir
    // ordering differs, with byte-identical content. Spec contribution is
    // ordered by node alias, never by enumeration, so the hash must not move.
    const drafts = join(cwd, ".sddx", "drafts");
    const a = readFileSync(join(drafts, "a.yaml"), "utf8");
    const b = readFileSync(join(drafts, "b.yaml"), "utf8");
    writeFileSync(join(drafts, "b.yaml"), b);
    writeFileSync(join(drafts, "a.yaml"), a);
    expect(planHash(graph).hash).toBe(first);
  });

  test("reordering nodes in the graph file DOES invalidate the hash", () => {
    // Deliberate: the graph contributes its raw bytes, so any edit — including a
    // semantically-neutral reorder — invalidates approval. A canonical semantic
    // hash would have to enumerate every meaningful field correctly, and missing
    // one (e.g. retry.max_attempts) would leave an edit silently approved. False
    // invalidation costs a re-approval; false validation is unbounded.
    const { graph } = planRepo();
    const first = planHash(graph).hash;
    writeFileSync(
      graph,
      `${GRAPH_HEADER}goal: do the thing
tasks:
  - alias: beta
    spec: b.yaml
    depends_on: alpha
  - alias: alpha
    spec: a.yaml
`,
    );
    expect(planHash(graph).hash).not.toBe(first);
  });

  test("changes when a field the graph gate reads is edited", () => {
    // guards the hole a semantic hash would open
    const { cwd, graph } = planRepo();
    const before = planHash(graph).hash;
    writeFileSync(
      join(cwd, ".sddx", "drafts", "a.yaml"),
      `${SPEC("first thing")}retry:\n  max_attempts: 50\n`,
    );
    expect(planHash(graph).hash).not.toBe(before);
  });

  test("changes when the goal sentence changes", () => {
    const { graph } = planRepo();
    const before = planHash(graph).hash;
    writeFileSync(graph, readFileSync(graph, "utf8").replace("do the thing", "do another thing"));
    expect(planHash(graph).hash).not.toBe(before);
  });

  test("changes when any referenced spec changes", () => {
    const { cwd, graph } = planRepo();
    const before = planHash(graph).hash;
    writeFileSync(join(cwd, ".sddx", "drafts", "b.yaml"), SPEC("second thing, revised"));
    expect(planHash(graph).hash).not.toBe(before);
  });

  test("changes when an edge changes", () => {
    const { graph } = planRepo();
    const before = planHash(graph).hash;
    writeFileSync(graph, readFileSync(graph, "utf8").replace("    depends_on: alpha\n", ""));
    expect(planHash(graph).hash).not.toBe(before);
  });

  // The Goal Brief is the graph file's header, so it rides the byte hash that
  // already covers the graph. These assert that guarantee holds rather than
  // introducing a second digest — a brief-specific digest would need its own
  // canonicalization, and every canonicalization layer is a surface on which
  // two different briefs can collide to one value.
  describe("covers the Goal Brief header", () => {
    const withHeader = (header: string) => {
      const cwd = fixtureRepo();
      const drafts = join(cwd, ".sddx", "drafts");
      mkdirSync(drafts, { recursive: true });
      writeFileSync(join(drafts, "a.yaml"), SPEC("first thing"));
      const graph = join(drafts, "graph.yaml");
      writeFileSync(graph, `${header}tasks:\n  - alias: alpha\n    spec: a.yaml\n`);
      return graph;
    };
    const BRIEF = `${GRAPH_HEADER}goal: do the thing
answers:
  - id: q1
    question: which store?
    answer: postgres
assumptions:
  - id: a1
    value: sessions are server-side
    rationale: no client storage in scope
`;

    test("an unchanged draft re-digests byte-identically on a later read", () => {
      const graph = withHeader(BRIEF);
      const first = planHash(graph).hash;
      // re-read from disk, as a separate process would
      writeFileSync(graph, readFileSync(graph, "utf8"));
      expect(planHash(graph).hash).toBe(first);
    });

    test("editing a recorded answer invalidates the hash", () => {
      const graph = withHeader(BRIEF);
      const before = planHash(graph).hash;
      writeFileSync(graph, readFileSync(graph, "utf8").replace("postgres", "sqlite"));
      expect(planHash(graph).hash).not.toBe(before);
    });

    test("editing a recorded assumption invalidates the hash", () => {
      const graph = withHeader(BRIEF);
      const before = planHash(graph).hash;
      writeFileSync(
        graph,
        readFileSync(graph, "utf8").replace("no client storage in scope", "the client stores it"),
      );
      expect(planHash(graph).hash).not.toBe(before);
    });

    test("switching interaction_mode invalidates the hash", () => {
      const graph = withHeader(BRIEF);
      const before = planHash(graph).hash;
      writeFileSync(
        graph,
        readFileSync(graph, "utf8").replace("interaction_mode: human", "interaction_mode: auto"),
      );
      expect(planHash(graph).hash).not.toBe(before);
    });

    test("a cosmetic header reorder also invalidates — the accepted cost of no canonicalization", () => {
      const graph = withHeader(BRIEF);
      const before = planHash(graph).hash;
      writeFileSync(
        graph,
        readFileSync(graph, "utf8").replace(
          'schema_version: "1.0"\ninteraction_mode: human\n',
          'interaction_mode: human\nschema_version: "1.0"\n',
        ),
      );
      expect(planHash(graph).hash).not.toBe(before);
    });

    test("an invalid header yields no digest at all, never a default one", () => {
      const graph = withHeader('schema_version: "1.0"\ngoal: do the thing\n');
      const r = planHash(graph);
      expect(r.hash).toBe("");
      expect(r.errors.join(" ")).toContain("interaction_mode");
    });
  });

  test("reports errors instead of hashing an unreadable plan", () => {
    const cwd = fixtureRepo();
    const graph = join(cwd, "nope.yaml");
    const r = planHash(graph);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.hash).toBe("");
  });

  test("reports an error when a referenced spec is missing", () => {
    const { cwd, graph } = planRepo();
    spawnSync("rm", [join(cwd, ".sddx", "drafts", "b.yaml")]);
    const r = planHash(graph);
    expect(r.errors.join("\n")).toContain("b.yaml");
    expect(r.hash).toBe("");
  });
});

describe("approval tokens", () => {
  test("are content-addressed by the plan hash", () => {
    const { cwd, graph } = planRepo();
    const { hash } = planHash(graph);
    writeApproval(cwd, { plan_sha256: hash, mode: "human" });
    expect(approvalPath(cwd, hash)).toBe(join(cwd, ".sddx", "approvals", `${hash}.json`));
    expect(readApproval(cwd, hash)?.plan_sha256).toBe(hash);
  });

  test("a written token is found for its plan", () => {
    const { cwd, graph } = planRepo();
    writeApproval(cwd, { plan_sha256: planHash(graph).hash, mode: "human" });
    const found = findApproval(cwd, graph);
    expect(found.ok).toBe(true);
    expect(found.approval?.mode).toBe("human");
  });

  test("an absent token is reported as missing, not as an error", () => {
    const { cwd, graph } = planRepo();
    const found = findApproval(cwd, graph);
    expect(found.ok).toBe(false);
    expect(found.reason).toContain("no approval");
    expect(found.approval).toBeUndefined();
  });

  test("editing a spec after approval invalidates the token", () => {
    const { cwd, graph } = planRepo();
    writeApproval(cwd, { plan_sha256: planHash(graph).hash, mode: "human" });
    expect(findApproval(cwd, graph).ok).toBe(true);

    writeFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), SPEC("first thing, edited"));
    const after = findApproval(cwd, graph);
    expect(after.ok).toBe(false);
    expect(after.reason).toContain("no approval");
  });

  test("a regenerated byte-identical plan reuses its approval", () => {
    const { cwd, graph } = planRepo();
    const original = readFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), "utf8");
    writeApproval(cwd, { plan_sha256: planHash(graph).hash, mode: "human" });

    writeFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), SPEC("something else entirely"));
    expect(findApproval(cwd, graph).ok).toBe(false);
    writeFileSync(join(cwd, ".sddx", "drafts", "a.yaml"), original);
    expect(findApproval(cwd, graph).ok).toBe(true);
  });

  test("an unreadable token is treated as absent, never as approval", () => {
    const { cwd, graph } = planRepo();
    const { hash } = planHash(graph);
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(approvalPath(cwd, hash), "{not json");
    expect(findApproval(cwd, graph).ok).toBe(false);
  });

  test("a token whose recorded hash disagrees with its filename is rejected", () => {
    const { cwd, graph } = planRepo();
    const { hash } = planHash(graph);
    mkdirSync(join(cwd, ".sddx", "approvals"), { recursive: true });
    writeFileSync(
      approvalPath(cwd, hash),
      JSON.stringify({ plan_sha256: "0".repeat(64), mode: "human", at: new Date().toISOString() }),
    );
    expect(findApproval(cwd, graph).ok).toBe(false);
  });
});

/** fixtureRepo + a throwaway SSH signing identity wired into git config. */
function signingRepo(): string {
  const cwd = fixtureRepo();
  const keyDir = mkdtempSync(join(tmpdir(), "sddx-approval-key-"));
  const key = join(keyDir, "id_ed25519");
  expect(spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]).status).toBe(0);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  const allowed = join(keyDir, "allowed_signers");
  writeFileSync(allowed, `fixture@example.invalid ${pub}\n`);
  const g = (...a: string[]) => spawnSync("git", a, { cwd });
  g("config", "gpg.format", "ssh");
  g("config", "user.signingkey", key);
  g("config", "gpg.ssh.allowedSignersFile", allowed);
  return cwd;
}

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
    const { cwd, graph } = planRepo();
    const token = writeApproval(cwd, { plan_sha256: planHash(graph).hash, mode: "human" });
    expect(token.signature).toBeUndefined();
    expect(findApproval(cwd, graph).ok).toBe(true);
  });

  test("a configured key produces a signed token that verifies", () => {
    const cwd = signingRepo();
    const drafts = join(cwd, ".sddx", "drafts");
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "a.yaml"), SPEC("only thing"));
    const graph = join(drafts, "graph.yaml");
    writeFileSync(graph, `${GRAPH_HEADER}goal: g\ntasks:\n  - alias: alpha\n    spec: a.yaml\n`);

    const { hash } = planHash(graph);
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

describe("goal-level assumptions denormalize into every spec", () => {
  test("a cross-cutting assumption reaches each node, node ones preserved", () => {
    const goalLevel = ["the project uses Vite"];
    const nodeA = { assumptions: ["a-only"] };
    const nodeB = { assumptions: [] as string[] };
    expect(mergeAssumptions(goalLevel, nodeA.assumptions)).toEqual([
      "the project uses Vite",
      "a-only",
    ]);
    expect(mergeAssumptions(goalLevel, nodeB.assumptions)).toEqual(["the project uses Vite"]);
  });

  test("a node repeating a goal assumption is not duplicated", () => {
    expect(mergeAssumptions(["shared"], ["shared", "mine"])).toEqual(["shared", "mine"]);
  });

  test("no goal assumptions leaves node assumptions untouched", () => {
    expect(mergeAssumptions([], ["mine"])).toEqual(["mine"]);
    expect(mergeAssumptions([], [])).toEqual([]);
  });
});
