// Spike 4: do response.body() calls hold on a page firing 2,000 fetches, read after the burst ends?
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "./fixture-server.mjs";

const requestCount = 2000;
const { server, origin } = await startFixtureServer();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spike4-")), { channel: "chrome", headless: false, viewport: null, chromiumSandbox: true });
const page = context.pages()[0] ?? await context.newPage();

const responses = [];
const failedRequests = [];
page.on("response", (response) => { if (response.url().includes("/blob/")) responses.push(response); });

page.on("requestfailed", (r) => failedRequests.push(r.failure()?.errorText));
const startedAtMs = Date.now();
await page.goto(`${origin}/busy?n=${requestCount}`);
await page.waitForFunction((n) => window.done === n, requestCount, { timeout: 120000 });
console.log("page-side fetch ok/failed:", await page.evaluate(() => [window.ok ?? 0, window.failed ?? 0], undefined, undefined, false));
console.log(`burst: ${responses.length} responses captured in ${Date.now() - startedAtMs} ms`);

console.log("requestfailed events:", failedRequests.length, [...new Set(failedRequests)]);
const readBodies = async (subset, label) => {
  let ok = 0;
  const failures = new Map();
  const readStartMs = Date.now();
  await Promise.all(subset.map(async (response) => {
    try {
      const body = await response.body();
      if (body.length > 2000) ok++;
    } catch (err) {
      const reason = err.message.split("\n")[0];
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
  }));
  console.log(`${label}: ${ok}/${subset.length} bodies ok in ${Date.now() - readStartMs} ms`, Object.fromEntries(failures));
};

await readBodies(responses.slice(0, 50), "oldest 50, after burst");
await readBodies(responses.slice(-50), "newest 50, after burst");
await readBodies(responses, "all, after burst");

await page.evaluate(() => fetch("/blob/after").then((r) => r.text()));
await page.reload();
await readBodies(responses.slice(0, 50), "oldest 50, after reload");
await context.close();
server.close();
