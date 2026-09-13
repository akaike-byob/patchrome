// Spike 2: stealth baseline on public detector pages, alone and with 3 background tabs plus network listeners.
// Usage: node spikes/02-stealth-baseline.mjs <outDir> [--busy]
import { chromium } from "patchright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const outDir = process.argv[2];
const isBusy = process.argv.includes("--busy");
mkdirSync(outDir, { recursive: true });

const detectors = [
  { name: "sannysoft", url: "https://bot.sannysoft.com/", settleMs: 8000 },
  { name: "creepjs", url: "https://abrahamjuliot.github.io/creepjs/", settleMs: 25000 },
  { name: "browserscan", url: "https://www.browserscan.net/bot-detection", settleMs: 15000 },
  { name: "turnstile", url: "https://2captcha.com/demo/cloudflare-turnstile", settleMs: 15000 },
];

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spike2-")), { channel: "chrome", headless: false, viewport: null, chromiumSandbox: true, ignoreDefaultArgs: process.argv.includes("--no-automation-flag") ? ["--disable-blink-features=AutomationControlled"] : [] });
const firstPage = context.pages()[0];
const cdp = await context.newCDPSession(firstPage);

const openBackgroundPage = async () => {
  const pagePromise = context.waitForEvent("page");
  await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  return pagePromise;
};

let networkEvents = 0;
if (isBusy) {
  for (const url of ["https://en.wikipedia.org/wiki/Special:Random", "https://news.ycombinator.com/", "https://example.com/"]) {
    const page = await openBackgroundPage();
    page.on("request", () => networkEvents++);
    page.on("response", (response) => { networkEvents++; response.body().catch(() => {}); });
    await page.goto(url).catch((err) => console.log("background tab", url, err.message.split("\n")[0]));
  }
}

console.log("navigator.webdriver:", await firstPage.evaluate(() => navigator.webdriver, undefined, undefined, false));
for (const detector of detectors) {
  const page = await openBackgroundPage();
  if (isBusy) {
    page.on("request", () => networkEvents++);
    page.on("response", (response) => { networkEvents++; response.body().catch(() => {}); });
  }
  try {
    await page.goto(detector.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(detector.settleMs);
    await page.screenshot({ path: join(outDir, `${detector.name}.png`), fullPage: true });
    writeFileSync(join(outDir, `${detector.name}.txt`), await page.locator("body").innerText());
    console.log(detector.name, "captured");
  } catch (err) {
    console.log(detector.name, "failed:", err.message.split("\n")[0]);
  }
}
console.log("network events observed:", networkEvents);
await context.close();
