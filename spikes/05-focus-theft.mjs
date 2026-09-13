// Spike 5: open and drive background tabs in headed Chrome on macOS without taking focus from the frontmost app.
import { chromium } from "patchright";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const frontmostApp = () =>
  execFileSync("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ])
    .toString()
    .trim();
const focusFinder = async () => {
  execFileSync("open", ["-a", "Finder"]);
  await sleep(1500);
};
const report = async (label, step) => {
  await focusFinder();
  await step();
  await sleep(1000);
  console.log(`${label}: frontmost=${frontmostApp()}`);
};

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spike5-")), {
  channel: "chrome",
  headless: false,
  viewport: null,
  chromiumSandbox: true,
});
const firstPage = context.pages()[0];
const html = "data:text/html,<title>t</title><input id=i><button onclick=\"i.value='x'\">b</button>";

let page;
await report("context.newPage()", async () => {
  page = await context.newPage();
});
await report("goto", () => page.goto(html));
await report("fill", () => page.locator("#i").fill("hello"));
await report("click", () => page.locator("button").click());
await report("press", () => page.keyboard.press("Enter"));
await report("screenshot", () => page.screenshot({ path: join(tmpdir(), "spike5.png") }));
await report("ariaSnapshot", () => page.locator("body").ariaSnapshot({ mode: "ai" }));

const cdp = await context.newCDPSession(firstPage);
let backgroundPage;
await report("CDP Target.createTarget background:true", async () => {
  const pagePromise = context.waitForEvent("page");
  await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  backgroundPage = await pagePromise;
});
await report("goto in background target", () => backgroundPage.goto(html));
await report("fill in background target", () => backgroundPage.locator("#i").fill("bg"));
console.log("background fill value:", await backgroundPage.locator("#i").inputValue());
await report("screenshot of non-selected tab", () =>
  backgroundPage.screenshot({ path: join(tmpdir(), "spike5-bg.png") }),
);

await context.close();
