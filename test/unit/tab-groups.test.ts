import { describe, expect, it } from "vitest";
import { tabGroupColorFor, tabGroupColors, tabGroupTitleFor } from "../../src/tab-groups.ts";

describe("tab group title and colour", () => {
  it("titles a group with the session name, then the label", () => {
    expect(tabGroupTitleFor("agent-1", undefined)).toBe("agent-1");
    expect(tabGroupTitleFor("agent-1", "checkout flow")).toBe("agent-1: checkout flow");
  });

  it("picks the same palette colour for a name every time", () => {
    expect(tabGroupColorFor("agent-1")).toBe(tabGroupColorFor("agent-1"));
    expect(tabGroupColors).toContain(tabGroupColorFor("claude-7f3a"));
    const colours = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(tabGroupColorFor));
    expect(colours.size).toBeGreaterThan(1);
  });
});
