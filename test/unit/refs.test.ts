import { describe, expect, it } from "vitest";
import { CommandError } from "../../src/protocol.ts";
import { parseRef, refsIn, SnapshotGenerations } from "../../src/refs.ts";

function errorCodeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof CommandError ? err.code : "not-a-command-error";
  }
  return undefined;
}

describe("parseRef", () => {
  it("accepts refs with and without the @ and the frame prefix", () => {
    expect(parseRef("@e12")).toBe("e12");
    expect(parseRef("e3")).toBe("e3");
    expect(parseRef("@f1e4")).toBe("f1e4");
  });

  it("rejects anything else as bad_args", () => {
    for (const input of ["", "@", "12", "@x12", "e12; drop", "@e"]) {
      expect(errorCodeOf(() => parseRef(input))).toBe("bad_args");
    }
  });
});

describe("refsIn", () => {
  it("collects plain and frame-prefixed refs", () => {
    expect(refsIn('- button "a" [ref=e1]\n- textbox [ref=f1e2]\n- paragraph')).toEqual(new Set(["e1", "f1e2"]));
  });
});

describe("SnapshotGenerations", () => {
  it("requires a snapshot before refs are used", () => {
    expect(errorCodeOf(() => new SnapshotGenerations().assertRefCurrent("e1"))).toBe("ref_stale");
  });

  it("accepts refs until the next navigation, then reports ref_stale", () => {
    const generations = new SnapshotGenerations();
    generations.recordNavigation();
    generations.recordSnapshot('- button "a" [ref=e1]');
    expect(errorCodeOf(() => generations.assertRefCurrent("e1"))).toBeUndefined();
    generations.recordNavigation();
    expect(errorCodeOf(() => generations.assertRefCurrent("e1"))).toBe("ref_stale");
    generations.recordSnapshot('- button "a" [ref=e1]');
    expect(errorCodeOf(() => generations.assertRefCurrent("e1"))).toBeUndefined();
  });

  it("reports ref_stale for a ref missing from the latest snapshot", () => {
    const generations = new SnapshotGenerations();
    generations.recordSnapshot('- button "a" [ref=f2e1]\n- button "b" [ref=f2e2]');
    expect(errorCodeOf(() => generations.assertRefCurrent("f1e243"))).toBe("ref_stale");
  });
});
