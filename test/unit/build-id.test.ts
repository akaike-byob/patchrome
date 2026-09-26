import { describe, expect, it } from "vitest";
import { isNewerBuild } from "../../src/build-id.ts";

describe("isNewerBuild", () => {
  it("orders releases by semver", () => {
    expect(isNewerBuild("1.4.0", "1.3.9")).toBe(true);
    expect(isNewerBuild("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerBuild("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerBuild("1.3.9", "1.4.0")).toBe(false);
    expect(isNewerBuild("1.4.0", "1.4.0")).toBe(false);
  });

  it("orders edits of one checkout by source mtime", () => {
    expect(isNewerBuild("0.0.0-development+200", "0.0.0-development+100")).toBe(true);
    expect(isNewerBuild("0.0.0-development+100", "0.0.0-development+200")).toBe(false);
  });

  it("leaves a checkout, a prerelease or an unknown id unordered against anything else", () => {
    expect(isNewerBuild("0.0.0-development+200", "0.0.0-development")).toBe(false);
    expect(isNewerBuild("9.9.9", "0.0.0-development+100")).toBe(false);
    expect(isNewerBuild("1.1.0+200", "1.0.0+100")).toBe(false);
    expect(isNewerBuild("2.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerBuild("banana", "1.0.0")).toBe(false);
  });
});
