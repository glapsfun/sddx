// Selection parsing survives the retirement of the current-branch catalog.
//
// `renderMenu`/`resolveSelection` operate on any `Action[]`, so they are shared
// by the goal-scoped run menu. The state detector and the static catalog it
// filtered are gone — a menu keyed to "is this branch pushed" answered a
// question about the checkout rather than about the run. Their tests went with
// them; what remains here is the part the run menu still depends on.
import { describe, expect, test } from "bun:test";
import { type Action, resolveSelection } from "../src/lib/next-actions";

describe("resolveSelection", () => {
  const A: Action = { id: "a", label: "Alpha", category: "git", validIn: [], implemented: true };
  const B: Action = {
    id: "b",
    label: "Beta",
    category: "git",
    validIn: [],
    aliases: ["shared"],
    implemented: true,
  };
  const C: Action = {
    id: "c",
    label: "Gamma",
    category: "git",
    validIn: [],
    aliases: ["shared"],
    implemented: true,
  };
  const visible = [A, B];

  test("numeric selection", () => {
    expect(resolveSelection("1", visible)).toBe(A);
    expect(resolveSelection("2", visible)).toBe(B);
  });

  test("label match is case-insensitive", () => {
    expect(resolveSelection("alpha", visible)).toBe(A);
    expect(resolveSelection("BETA", visible)).toBe(B);
  });

  test("alias match", () => {
    expect(resolveSelection("shared", visible)).toBe(B);
  });

  test("selection not currently visible is refused", () => {
    const res = resolveSelection("gamma", visible);
    expect(res).toEqual({ error: "not-found" });
    expect(resolveSelection("3", visible)).toEqual({ error: "not-found" });
  });

  test("ambiguous free text is refused", () => {
    const res = resolveSelection("shared", [B, C]);
    expect(res).toEqual({ error: "ambiguous" });
  });
});
