// Spike 2b: full-page screenshot of a page in plain, unautomated Chrome, as a fingerprint baseline.
// Attaches over CDP only after the page has settled, and uses only the Page domain (no Runtime.enable).
// Usage: node spikes/02b-plain-chrome-screenshot.mjs <url> <out.png> [settleMs]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [url, outPath, settleMsArg] = process.argv.slice(2);
const settleMs = Number(settleMsArg ?? 30000);
const debugPort = 9333;
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "plain-chrome-"))}`,
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ],
  { stdio: "ignore" },
);

await sleep(settleMs);
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.startsWith(url));
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let nextId = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });

const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: undefined });
const { cssContentSize } = await send("Page.getLayoutMetrics");
const full = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
});
writeFileSync(outPath, Buffer.from(full?.data ?? data, "base64"));
console.log("wrote", outPath, cssContentSize);
socket.close();
chrome.kill();
