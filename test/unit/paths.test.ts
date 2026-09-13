import { describe, expect, it } from "vitest";
import { idleMsFrom, profilePaths, sessionFolderName } from "../../src/paths.ts";
import { CommandError } from "../../src/protocol.ts";

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof CommandError ? err.code : "not-a-command-error";
  }
  return undefined;
}

describe("sessionFolderName", () => {
  it("keeps distinct session names in distinct folders", () => {
    const names = ["a/b", "a_b", "a b", "a.b", "claude-1234", "tty-ttys008"];
    const folders = names.map(sessionFolderName);
    expect(new Set(folders).size).toBe(names.length);
    for (const folder of folders) expect(folder).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("leaves ordinary names readable", () => {
    expect(sessionFolderName("claude-d1ea9f40-abb0")).toBe("claude-d1ea9f40-abb0");
  });
});

describe("idleMsFrom", () => {
  it("defaults to 30 minutes", () => {
    expect(idleMsFrom({})).toBe(1_800_000);
  });

  it("rejects values that setTimeout would turn into 1 ms", () => {
    for (const raw of ["soon", "", "0", "-5", "1.5"]) {
      expect(
        errorCodeOf(() => idleMsFrom({ PATCHROME_IDLE_MS: raw })),
        raw,
      ).toBe("bad_args");
    }
  });
});

describe("profilePaths", () => {
  it("rejects a socket path past the macOS limit", () => {
    expect(errorCodeOf(() => profilePaths("p".repeat(64), { PATCHROME_HOME: "/Users/someone/.cache/patchrome" }))).toBe(
      "bad_args",
    );
    expect(
      errorCodeOf(() => profilePaths("stealth", { PATCHROME_HOME: "/Users/someone/.cache/patchrome" })),
    ).toBeUndefined();
  });
});
