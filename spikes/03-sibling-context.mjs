// Spike 3: an isolated browser context next to a persistent one, via CDP Target.createBrowserContext.
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "./fixture-server.mjs";

const { server, origin } = await startFixtureServer();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spike3-")), { channel: "chrome", headless: false, viewport: null, chromiumSandbox: true });
const persistentPage = context.pages()[0] ?? await context.newPage();
await persistentPage.goto(`${origin}/set-cookie`);
await persistentPage.goto(`${origin}/whoami`);
console.log("persistent cookie:", await persistentPage.locator("#c").textContent());

// Runtime.enable leak probe: an Error whose stack getter fires only when a CDP client serialises console args.
const probeRuntimeLeak = (page) => page.evaluate(() => {
  let touched = false;
  const err = new Error();
  Object.defineProperty(err, "stack", { get() { touched = true; return ""; } });
  console.debug(err);
  return touched;
});
console.log("runtime leak before CDP work:", await probeRuntimeLeak(persistentPage));

const cdp = await context.newCDPSession(persistentPage);
let browserCdp;
try {
  browserCdp = await context.browser()?.newBrowserCDPSession();
} catch (err) {
  console.log("browser CDP session:", err.message.split("\n")[0]);
}
console.log("context.browser():", context.browser() ? "present" : "null");

const session = browserCdp ?? cdp;
const { browserContextId } = await session.send("Target.createBrowserContext", { disposeOnDetach: false });
console.log("created browserContextId:", browserContextId);

const pagePromise = context.waitForEvent("page", { timeout: 5000 }).catch((err) => err);
const { targetId } = await session.send("Target.createTarget", { url: `${origin}/whoami`, browserContextId, background: true });
const isolatedPage = await pagePromise;
if (isolatedPage instanceof Error) {
  console.log("isolated page surfaced to Playwright:", isolatedPage.message.split("\n")[0]);
} else {
  await isolatedPage.waitForLoadState();
  console.log("isolated page surfaced as page of persistent context, targetId", targetId);
  console.log("isolated cookie:", await isolatedPage.locator("#c").textContent());
  console.log("runtime leak in isolated page:", await probeRuntimeLeak(isolatedPage));
  const snap = await isolatedPage.locator("body").ariaSnapshot({ mode: "ai" });
  console.log("snapshot in isolated page ok:", snap.includes("ref="));
  const cookieNames = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`);
  console.log("context.cookies() sees:", cookieNames);
  await isolatedPage.goto(`${origin}/set-cookie`);
  await persistentPage.reload();
  console.log("persistent cookie after isolated set:", await persistentPage.locator("#c").textContent());
}
console.log("runtime leak after CDP work:", await probeRuntimeLeak(persistentPage));
await context.close();
server.close();
