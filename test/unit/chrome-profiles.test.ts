import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chromeUserDataDirFrom,
  hostBelongsToSite,
  isGoogleHost,
  localStorageOrigins,
  originOfIndexedDbFolder,
  resolveChromeProfile,
  siteFromInput,
  siteStorageOrigins,
} from "../../src/chrome-profiles.ts";
import { CommandError } from "../../src/protocol.ts";

const profiles = [
  { folder: "Default", name: "Ujjwal", email: "me@gmail.test" },
  { folder: "Profile 1", name: "akaiketech.com", email: "admin@akaiketech.test" },
];

describe("Chrome profiles", () => {
  it("finds the everyday Chrome user data dir per platform, unless the env names one", () => {
    expect(chromeUserDataDirFrom({}, "darwin", "/Users/ada")).toBe(
      "/Users/ada/Library/Application Support/Google/Chrome",
    );
    expect(chromeUserDataDirFrom({}, "linux", "/home/ada")).toBe("/home/ada/.config/google-chrome");
    expect(chromeUserDataDirFrom({ LOCALAPPDATA: "C:/Users/ada/AppData/Local" }, "win32", "C:/Users/ada")).toBe(
      join("C:/Users/ada/AppData/Local", "Google", "Chrome", "User Data"),
    );
    expect(chromeUserDataDirFrom({ PATCHROME_CHROME_USER_DATA_DIR: "/tmp/beta" }, "darwin", "/Users/ada")).toBe(
      "/tmp/beta",
    );
  });

  it("resolves --from by menu name, folder or email, case-insensitively, and defaults to the last used profile", () => {
    expect(resolveChromeProfile(profiles, "AKAIKETECH.COM", undefined).folder).toBe("Profile 1");
    expect(resolveChromeProfile(profiles, "profile 1", undefined).folder).toBe("Profile 1");
    expect(resolveChromeProfile(profiles, "me@gmail.test", undefined).folder).toBe("Default");
    expect(resolveChromeProfile(profiles, undefined, "Profile 1").folder).toBe("Profile 1");
    expect(resolveChromeProfile(profiles, undefined, undefined).folder).toBe("Default");
  });

  it("lists every profile when --from matches none or several", () => {
    const miss = (() => {
      try {
        resolveChromeProfile(profiles, "School", undefined);
      } catch (err) {
        return err;
      }
    })();
    expect(miss).toBeInstanceOf(CommandError);
    expect((miss as CommandError).hint).toBe(
      `pass --from with one of: "Ujjwal" (Default, me@gmail.test), "akaiketech.com" (Profile 1, admin@akaiketech.test)`,
    );
    expect(() =>
      resolveChromeProfile(
        [...profiles, { folder: "Profile 2", name: "Ujjwal", email: undefined }],
        "ujjwal",
        undefined,
      ),
    ).toThrow("names more than one Chrome profile");
  });

  it("reads a site from a host or a pasted URL, and matches its subdomains only", () => {
    expect(siteFromInput("GitHub.com")).toBe("github.com");
    expect(siteFromInput("https://app.example.com:8443/login?next=1")).toBe("app.example.com");
    expect(siteFromInput(".example.com")).toBe("example.com");
    expect(() => siteFromInput("not a site")).toThrow(CommandError);
    expect(hostBelongsToSite(".example.com", "example.com")).toBe(true);
    expect(hostBelongsToSite("app.example.com", "example.com")).toBe(true);
    expect(hostBelongsToSite("badexample.com", "example.com")).toBe(false);
    expect(hostBelongsToSite("example.com", "app.example.com")).toBe(false);
  });

  it("knows Google's hosts, across country domains, and nothing that only contains the word", () => {
    for (const host of [
      "google.com",
      ".google.com",
      "accounts.google.com",
      "google.co.in",
      "mail.google.com.au",
      "google.de",
    ])
      expect(isGoogleHost(host), host).toBe(true);
    for (const host of ["notgoogle.com", "google.example.com", "github.com", "googleusercontent.com"])
      expect(isGoogleHost(host), host).toBe(false);
  });

  it("names origins from IndexedDB folders and localStorage META keys", async () => {
    expect(originOfIndexedDbFolder("https_app.example.com_0.indexeddb.leveldb")).toBe("https://app.example.com");
    expect(originOfIndexedDbFolder("http_127.0.0.1_8080.indexeddb.leveldb")).toBe("http://127.0.0.1:8080");
    expect(originOfIndexedDbFolder("chrome-extension_abc_0.indexeddb.leveldb")).toBeUndefined();
    expect(originOfIndexedDbFolder("https_app.example.com_0.indexeddb.blob")).toBeUndefined();

    const leveldbDir = mkdtempSync(join(tmpdir(), "patchrome-leveldb-"));
    writeFileSync(
      join(leveldbDir, "000003.log"),
      Buffer.concat([
        Buffer.from([0, 1, 7]),
        Buffer.from("META:https://app.example.com\u0000\u0008_https://app.example.com\u0000\u0001token"),
        Buffer.from("META:http://127.0.0.1:9000\u0001"),
      ]),
    );
    writeFileSync(join(leveldbDir, "MANIFEST-000001"), "META:https://ignored.example.com");
    expect((await localStorageOrigins(leveldbDir)).toSorted()).toEqual([
      "http://127.0.0.1:9000",
      "https://app.example.com",
    ]);
  });

  it("lists a live profile's site origins without copying the site's data", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "patchrome-profile-"));
    const leveldbDir = join(profileDir, "Local Storage", "leveldb");
    mkdirSync(leveldbDir, { recursive: true });
    writeFileSync(join(leveldbDir, "000005.ldb"), "META:https://app.example.com\u0001META:https://other.test\u0001");
    mkdirSync(join(profileDir, "IndexedDB", "https_id.example.com_0.indexeddb.leveldb"), { recursive: true });
    mkdirSync(join(profileDir, "IndexedDB", "https_other.test_0.indexeddb.leveldb"), { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "patchrome-storage-origins-"));
    expect(await siteStorageOrigins(profileDir, "example.com", workDir)).toEqual([
      "https://app.example.com",
      "https://id.example.com",
    ]);
    expect(readdirSync(workDir)).toEqual([]);
  });
});
