import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { makeHome, makeTestChrome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

// Playwright names files to Chrome by path. On WSL those are Linux paths the Windows Chrome opens only after
// the relay rewrites them, so this drives Chrome the way the daemon launches it.
describe("files between this machine and Chrome", () => {
  let fixture: FixtureServer;
  let chrome: BrowserContext;
  let page: Page;
  const disk = makeHome("files");

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const { userDataDir, launch } = await makeTestChrome("files-chrome");
    chrome = await chromium.launchPersistentContext(userDataDir, { ...launch, headless: true });
    page = await chrome.newPage();
    await page.goto(`${fixture.origin}/files`);
  });

  afterAll(async () => {
    await chrome.close();
    await fixture.close();
  });

  it("uploads a file, several files and a folder from disk", async () => {
    const notes = join(disk, "notes one.txt");
    writeFileSync(notes, "first file");
    writeFileSync(join(disk, "second.txt"), "second file");
    const folder = join(disk, "photos");
    mkdirSync(join(folder, "trip"), { recursive: true });
    writeFileSync(join(folder, "trip", "a.txt"), "in a folder");

    await page.setInputFiles("#one", notes);
    await page.setInputFiles("#many", [notes, join(disk, "second.txt")]);
    await page.setInputFiles("#folder", folder);

    const received = await page.evaluate(async () => {
      const read = async (selector: string) =>
        Promise.all(
          [...(document.querySelector<HTMLInputElement>(selector)?.files ?? [])].map(async (file) => ({
            name: file.webkitRelativePath || file.name,
            text: await file.text(),
          })),
        );
      return { one: await read("#one"), many: await read("#many"), folder: await read("#folder") };
    });
    expect(received).toEqual({
      one: [{ name: "notes one.txt", text: "first file" }],
      many: [
        { name: "notes one.txt", text: "first file" },
        { name: "second.txt", text: "second file" },
      ],
      folder: [{ name: "photos/trip/a.txt", text: "in a folder" }],
    });
  });

  it("saves a download where Playwright reads it", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#report")]);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe("report.csv");
    expect(readFileSync(await download.path(), "utf8")).toBe("sku,price\na1,10\n");
    const saved = join(disk, "saved.csv");
    await download.saveAs(saved);
    expect(readFileSync(saved, "utf8")).toBe("sku,price\na1,10\n");
  });
});

describe("downloads from a patchrome tab", () => {
  let fixture: FixtureServer;
  const home = makeHome("downloads");
  const downloadsDir = join(home, "downloads");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  async function readOnceSaved(path: string): Promise<string> {
    for (let attempt = 0; attempt < 50 && !existsSync(path); attempt++) await sleep(100);
    return readFileSync(path, "utf8");
  }

  it("keeps the file under its own name in the downloads folder", async () => {
    expect((await runCli(home, "shared", ["open", `${fixture.origin}/files`])).json.ok).toBe(true);
    expect((await runCli(home, "shared", ["click", "--selector", "#report"])).json.ok).toBe(true);
    expect(await readOnceSaved(join(downloadsDir, "report.csv"))).toBe("sku,price\na1,10\n");
  });

  it("saves an isolated session's download to the same folder", async () => {
    expect((await runCli(home, "sealed", ["open", "--isolated", `${fixture.origin}/files`])).json.ok).toBe(true);
    expect((await runCli(home, "sealed", ["click", "--selector", "#report"])).json.ok).toBe(true);
    expect(await readOnceSaved(join(downloadsDir, "report (1).csv"))).toBe("sku,price\na1,10\n");
  });

  it("leaves nothing behind in the staging folder", async () => {
    const stagingRoot = join(downloadsDir, ".patchrome-downloading");
    const [stagingDir] = readdirSync(stagingRoot);
    expect(readdirSync(join(stagingRoot, stagingDir ?? ""))).toEqual([]);
  });
});
