import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";
import { parseStorageState } from "../../src/commands.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeHome,
  runCli,
  startDaemonAnsweringCopies,
  startFixtureServer,
  stopDaemon,
  type FixtureServer,
} from "./helpers.ts";

// The records /auth-seed stores, read back in a page. The Date and the bytes are what JSON alone would lose.
const readSeededRecords = `new Promise((resolve) => {
  const opening = indexedDB.open("auth");
  opening.onsuccess = () => {
    const tx = opening.result.transaction(["users", "tokens"]);
    const user = tx.objectStore("users").index("byEmail").get("ada@example.test");
    const refresh = tx.objectStore("tokens").get("firebase:authUser");
    tx.oncomplete = () => resolve({ version: opening.result.version, signedInAt: user.result.signedInAt.toISOString(), key: [...user.result.key], refresh: refresh.result });
  };
})`;
const seededRecords = { version: 3, signedInAt: "2023-11-14T22:13:20.000Z", key: [7, 8, 9], refresh: "refresh-token" };

// Stands in for the everyday Chrome: a user data dir whose cookies Chrome encrypted with the real keychain key.
async function seedEverydayChrome(fixture: FixtureServer): Promise<string> {
  const userDataDir = makeHome("everyday-chrome");
  const chrome = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: true,
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  });
  const page = await chrome.newPage();
  await page.goto(`${fixture.origin}/auth-seed`);
  await page.waitForFunction(() => document.title === "seeded");
  const otherSite = fixture.origin.replace("127.0.0.1", "localhost");
  await page.goto(`${otherSite}/auth-seed`);
  await page.waitForFunction(() => document.title === "seeded");
  await chrome.close();
  renameSync(join(userDataDir, "Default"), join(userDataDir, "Profile 1"));
  mkdirSync(join(userDataDir, "Default"));
  writeFileSync(
    join(userDataDir, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: {
          Default: { name: "Personal", user_name: "" },
          "Profile 1": { name: "Work", user_name: "ada@example.test" },
        },
      },
    }),
  );
  return userDataDir;
}

describe("state import from the everyday Chrome", () => {
  let fixture: FixtureServer;
  let chromeEnv: NodeJS.ProcessEnv;
  const home = makeHome("import");
  const denyingHome = makeHome("import-denied");
  const otherMachineHome = makeHome("export-loaded");
  let approvals: { asked: string[] };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    chromeEnv = { PATCHROME_CHROME_USER_DATA_DIR: await seedEverydayChrome(fixture) };
    approvals = await startDaemonAnsweringCopies(home, "approved");
  });

  afterAll(async () => {
    await stopDaemon(home);
    await stopDaemon(denyingHome);
    await stopDaemon(otherMachineHome);
    await fixture.close();
  });

  it("brings one site's cookies, localStorage and IndexedDB into the shared profile, and nothing else", async () => {
    const imported = await runCli(home, "importer", ["state", "import", "127.0.0.1", "--from", "work"], chromeEnv);
    expect(approvals.asked).toEqual([
      `import the 127.0.0.1 login (1 cookie and storage for 1 origin) from Chrome profile "Work" (Profile 1, ada@example.test) into patchrome profile stealth (shared by every session). Asked by agent session importer.`,
    ]);
    expect(imported.json).toMatchObject({
      ok: true,
      data: {
        site: "127.0.0.1",
        chromeProfile: { folder: "Profile 1", name: "Work" },
        cookies: 1,
        origins: [{ origin: fixture.origin, localStorageItems: 1, indexedDB: ["auth"] }],
      },
    });

    // A different session sees the login, because the profile is shared.
    const opened = await runCli(home, "reader", ["open", `${fixture.origin}/form`]);
    expect(opened.json, opened.stderr).toMatchObject({ ok: true });
    const cookies = await runCli(home, "reader", ["cookies"]);
    expect(cookies.json.data?.cookies).toEqual([
      expect.objectContaining({ name: "sid", value: "from-chrome", domain: "127.0.0.1" }),
    ]);
    const token = await runCli(home, "reader", ["eval", "localStorage.getItem('token')"]);
    expect(token.json.data?.value).toBe("ls-token");
    const records = await runCli(home, "reader", ["eval", readSeededRecords]);
    expect(records.json.data?.value).toEqual(seededRecords);

    // The seeded Chrome also signed in to localhost; the import named 127.0.0.1 only.
    expect((await runCli(home, "reader", ["cookies", "--domain", "localhost"])).json.data?.cookies).toEqual([]);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("patchrome-login-copy-"))).toEqual([]);
  });

  it("imports into an isolated session without touching the shared profile", async () => {
    await runCli(home, "sealed", ["open", "--isolated"]);
    const imported = await runCli(
      home,
      "sealed",
      ["state", "import", `${fixture.origin.replace("127.0.0.1", "localhost")}/form`, "--from", "Profile 1"],
      chromeEnv,
    );
    expect(imported.json).toMatchObject({ ok: true, data: { site: "localhost", cookies: 1 } });
    expect((await runCli(home, "sealed", ["cookies", "--domain", "localhost"])).json.data?.cookies).toEqual([
      expect.objectContaining({ name: "sid", value: "from-chrome" }),
    ]);
    expect((await runCli(home, "reader", ["cookies", "--domain", "localhost"])).json.data?.cookies).toEqual([]);
  });

  it("exports a site's login to a file that another patchrome and Playwright both load", async () => {
    const file = join(makeHome("export-file"), "login.json");
    const exported = await runCli(home, "exporter", ["state", "export", "127.0.0.1", file]);
    expect(exported.json, exported.stderr).toMatchObject({
      ok: true,
      data: {
        site: "127.0.0.1",
        path: file,
        cookies: 1,
        origins: [{ origin: fixture.origin, localStorageItems: 1, indexedDB: ["auth"] }],
      },
    });
    expect(approvals.asked.at(-1)).toBe(
      `export the 127.0.0.1 login (1 cookie and storage for 1 origin) from patchrome profile stealth (shared by every session) to file ${file}. Asked by agent session exporter.`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      cookies: [expect.objectContaining({ name: "sid", value: "from-chrome" })],
      origins: [{ origin: fixture.origin, localStorage: [{ name: "token", value: "ls-token" }] }],
    });

    await startDaemonAnsweringCopies(otherMachineHome, "approved");
    const loaded = await runCli(otherMachineHome, "loader", ["state", "load", file]);
    expect(loaded.json, loaded.stderr).toMatchObject({ ok: true, data: { cookies: 1 } });
    await runCli(otherMachineHome, "loader", ["open", `${fixture.origin}/form`]);
    expect((await runCli(otherMachineHome, "loader", ["cookies"])).json.data?.cookies).toEqual([
      expect.objectContaining({ name: "sid", value: "from-chrome" }),
    ]);
    expect((await runCli(otherMachineHome, "loader", ["eval", "localStorage.getItem('token')"])).json.data?.value).toBe(
      "ls-token",
    );
    expect((await runCli(otherMachineHome, "loader", ["eval", readSeededRecords])).json.data?.value).toEqual(
      seededRecords,
    );

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext({ storageState: file });
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/form`);
      expect(await page.evaluate(readSeededRecords)).toEqual(seededRecords);
      const writtenByPlaywright = await context.storageState({ indexedDB: true });
      expect(parseStorageState(JSON.stringify(writtenByPlaywright)).origins).toEqual(
        parseStorageState(readFileSync(file, "utf8")).origins,
      );
    } finally {
      await browser.close();
    }
  });

  it("exports an isolated session's own login, and refuses Google and a site with no login", async () => {
    const file = join(makeHome("export-isolated"), "login.json");
    const isolated = await runCli(home, "sealed", ["state", "export", "localhost", file]);
    expect(isolated.json, isolated.stderr).toMatchObject({ ok: true, data: { site: "localhost", cookies: 1 } });

    const google = await runCli(home, "exporter", ["state", "export", "https://accounts.google.com/", file]);
    expect(google.exitCode).toBe(2);
    expect(google.json.error?.message).toBe("patchrome does not export Google logins");

    const empty = await runCli(home, "exporter", ["state", "export", "example.test", file]);
    expect(empty.exitCode).toBe(2);
    expect(empty.json.error?.message).toBe(
      "patchrome profile stealth (shared by every session) has no cookies or storage for example.test",
    );
  });

  it("copies nothing when the person does not approve, and records the refusal", async () => {
    const denials = await startDaemonAnsweringCopies(denyingHome, "denied");
    const refused = await runCli(
      denyingHome,
      "importer",
      ["state", "import", "127.0.0.1", "--from", "work"],
      chromeEnv,
    );
    expect(denials.asked).toHaveLength(1);
    expect(refused.exitCode).toBe(1);
    expect(refused.json.error).toMatchObject({ code: "copy_denied" });
    await runCli(denyingHome, "reader", ["open", `${fixture.origin}/form`]);
    expect((await runCli(denyingHome, "reader", ["cookies"])).json.data?.count).toBe(0);
    const audit = await runCli(denyingHome, "reader", ["audit"]);
    expect(audit.json.data?.entries).toEqual([
      expect.objectContaining({ kind: "state-import", session: "importer", site: "127.0.0.1", decision: "denied" }),
    ]);
  });

  it("names the Chrome profiles when --from matches none, and reports a site with no login", async () => {
    const unknown = await runCli(home, "importer", ["state", "import", "127.0.0.1", "--from", "School"], chromeEnv);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.json.error?.message).toBe("no Chrome profile named School");
    expect(unknown.json.error?.hint).toBe(
      `pass --from with one of: "Personal" (Default), "Work" (Profile 1, ada@example.test)`,
    );

    const empty = await runCli(home, "importer", ["state", "import", "127.0.0.1"], chromeEnv);
    expect(empty.exitCode).toBe(2);
    expect(empty.json.error?.message).toBe(
      `Chrome profile "Personal" (Default) has no cookies or storage for 127.0.0.1`,
    );
  });
});
