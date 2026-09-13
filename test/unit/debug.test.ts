import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consoleLevelOf, isAtLeast, parseConsoleLevel, renderRemoteObject } from "../../src/diagnostics.ts";
import { profilePaths } from "../../src/paths.ts";
import { defaultModeFor, fixProfileMode, readProfileMode } from "../../src/profile-mode.ts";
import { CommandError } from "../../src/protocol.ts";

describe("profile mode", () => {
  const env = () => ({ PATCHROME_HOME: mkdtempSync(join(tmpdir(), "patchrome-mode-")) });

  it("defaults from the profile name", () => {
    expect(defaultModeFor("debug")).toBe("debug");
    expect(defaultModeFor("stealth")).toBe("stealth");
    expect(defaultModeFor("work")).toBe("stealth");
  });

  it("writes the mode once and refuses to change it", async () => {
    const paths = profilePaths("work", env());
    expect(await readProfileMode(paths)).toBeUndefined();
    expect(await fixProfileMode(paths, "work", "debug")).toEqual({ mode: "debug", isNew: true });
    expect(await fixProfileMode(paths, "work", undefined)).toEqual({ mode: "debug", isNew: false });
    expect(await fixProfileMode(paths, "work", "debug")).toEqual({ mode: "debug", isNew: false });
    await expect(fixProfileMode(paths, "work", "stealth")).rejects.toThrow(/already a debug profile/);
  });
});

describe("console capture helpers", () => {
  it("maps CDP console types to levels and filters by minimum", () => {
    expect(consoleLevelOf("assert")).toBe("error");
    expect(consoleLevelOf("warning")).toBe("warning");
    expect(consoleLevelOf("table")).toBe("info");
    expect(isAtLeast("error", "warning")).toBe(true);
    expect(isAtLeast("info", "warning")).toBe(false);
    expect(parseConsoleLevel("warning")).toBe("warning");
    expect(() => parseConsoleLevel("warn")).toThrow(CommandError);
  });

  it("renders console arguments the way DevTools prints them", () => {
    expect(renderRemoteObject({ type: "string", value: "hi" })).toBe("hi");
    expect(renderRemoteObject({ type: "number", value: 42 })).toBe("42");
    expect(renderRemoteObject({ type: "number", unserializableValue: "NaN" })).toBe("NaN");
    expect(renderRemoteObject({ type: "undefined" })).toBe("undefined");
    expect(renderRemoteObject({ type: "object", subtype: "array", description: "Array(3)" })).toBe("Array(3)");
  });
});
