import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromeHostFor } from "../../src/engine.ts";
import { CommandError } from "../../src/protocol.ts";
import {
  ProtocolMessages,
  relayScript,
  requireMirroredNetworking,
  shellWord,
  windowsChromeProfileDirFor,
  windowsCommandLine,
  withWindowsPaths,
  writeChromeLauncher,
} from "../../src/windows-chrome.ts";

const windowsChrome = {
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  localAppDataDir: "/mnt/c/Users/ada/AppData/Local",
};

describe("Windows Chrome on WSL", () => {
  it("runs the Windows Chrome only on WSL", () => {
    expect(chromeHostFor("wsl")).toBe("windows");
    expect(chromeHostFor("macos")).toBe("local");
    expect(chromeHostFor("linux")).toBe("local");
  });

  it("quotes Chrome arguments the way CommandLineToArgvW splits them", () => {
    expect(windowsCommandLine(["--no-first-run", "--disable-features=A,B"])).toBe(
      "--no-first-run --disable-features=A,B",
    );
    expect(windowsCommandLine(["--user-data-dir=C:\\Users\\Ada Lovelace\\patchrome"])).toBe(
      '"--user-data-dir=C:\\Users\\Ada Lovelace\\patchrome"',
    );
    expect(windowsCommandLine(["C:\\dir with space\\"])).toBe('"C:\\dir with space\\\\"');
    expect(windowsCommandLine(['say "hi"', 'a\\"b', ""])).toBe('"say \\"hi\\"" "a\\\\\\"b" ""');
  });

  it("gives each Linux profile its own Chrome profile on the Windows disk", () => {
    const stealth = windowsChromeProfileDirFor(
      windowsChrome,
      "/home/ada/.cache/patchrome/stealth/chrome-profile",
      "Ubuntu",
    );
    expect(stealth).toMatch(/^\/mnt\/c\/Users\/ada\/AppData\/Local\/patchrome\/wsl\/stealth-[0-9a-f]{12}$/);
    expect(windowsChromeProfileDirFor(windowsChrome, "/tmp/other-home/stealth/chrome-profile", "Ubuntu")).not.toBe(
      stealth,
    );
    expect(
      windowsChromeProfileDirFor(windowsChrome, "/home/ada/.cache/patchrome/stealth/chrome-profile", "Debian"),
    ).not.toBe(stealth);
    expect(
      windowsChromeProfileDirFor(windowsChrome, "/home/ada/.cache/patchrome/stealth/chrome-profile", "Ubuntu"),
    ).toBe(stealth);
  });

  it("writes a launcher that passes chrome.exe and every argument through to the relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patchrome-launcher-"));
    const launcherPath = await writeChromeLauncher(dir, { ...windowsChrome, chromePath: "C:\\Ada's\\chrome.exe" });
    expect(readFileSync(launcherPath, "utf8")).toMatch(
      /^#!\/bin\/sh\nexec '[^']+' '[^']+windows-chrome-relay\.ts' 'C:\\Ada'\\''s\\chrome\.exe' "\$@"\n$/,
    );
    // A quote inside a word stays one shell word.
    expect(
      execFileSync("sh", ["-c", `printf '%s\\n' ${shellWord("it's")} "$@"`, "sh", "a b"], { encoding: "utf8" }),
    ).toBe("it's\na b\n");
  });

  it("passes chrome.exe and its arguments into PowerShell as base64, never as code", () => {
    const hostile = `'); Remove-Item C:\\ -Recurse; ('`;
    const script = relayScript(hostile, hostile);
    expect(script).not.toContain("Remove-Item");
  });

  it("splits the pipe's NUL-ended messages however the chunks fall", () => {
    const messages: string[] = [];
    const splitter = new ProtocolMessages((message) => messages.push(message.toString("utf8")));
    splitter.push(Buffer.from('{"id":1}\0{"id"'));
    splitter.push(Buffer.from(":2"));
    splitter.push(Buffer.from('}\0{"id":3}\0'));
    expect(messages).toEqual(['{"id":1}\0', '{"id":2}\0', '{"id":3}\0']);
  });

  it("rewrites the paths of downloads and uploaded files for the Windows Chrome, and nothing else", () => {
    const toWindowsPath = (path: string) => `W:${path}`;
    const rewrite = (request: object) =>
      withWindowsPaths(Buffer.from(`${JSON.stringify(request)}\0`), toWindowsPath).toString("utf8");
    expect(
      rewrite({
        id: 1,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/tmp/a" },
      }),
    ).toBe(
      `${JSON.stringify({ id: 1, method: "Browser.setDownloadBehavior", params: { behavior: "allowAndName", downloadPath: "W:/tmp/a" } })}\0`,
    );
    expect(
      rewrite({
        id: 2,
        sessionId: "s",
        method: "DOM.setFileInputFiles",
        params: { objectId: "o", files: ["/a b", "/mnt/c/x"] },
      }),
    ).toBe(
      `${JSON.stringify({ id: 2, sessionId: "s", method: "DOM.setFileInputFiles", params: { objectId: "o", files: ["W:/a b", "W:/mnt/c/x"] } })}\0`,
    );
    const untouched = {
      id: 3,
      method: "Runtime.evaluate",
      params: { expression: "'Browser.setDownloadBehavior'", files: ["/a"] },
    };
    expect(rewrite(untouched)).toBe(`${JSON.stringify(untouched)}\0`);
  });

  it("refuses NAT networking, pointing at mirrored mode and at an issue for NAT", async () => {
    await expect(requireMirroredNetworking(async () => "mirrored")).resolves.toBeUndefined();
    const refusal = await requireMirroredNetworking(async () => "nat").catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(CommandError);
    expect(refusal).toMatchObject({
      code: "setup_required",
      message: "WSL networking mode is nat; patchrome on WSL supports mirrored networking only",
      hint: "add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, run `wsl --shutdown` from Windows, and retry. If you need nat mode, open an issue at https://github.com/akaike-byob/patchrome/issues/new",
    });
    const unreadable = await requireMirroredNetworking(async () => {
      throw new Error("spawn wslinfo ENOENT");
    }).catch((err: unknown) => err);
    expect(unreadable).toMatchObject({
      code: "setup_required",
      message: "cannot read the WSL networking mode: Error: spawn wslinfo ENOENT",
    });
  });
});
