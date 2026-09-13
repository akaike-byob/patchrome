// When does Chrome take focus for a page-opened tab or window, relative to Playwright's `page` event?
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "patchright";

const run = promisify(execFile);
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6);
const front = async () =>
  (await run("/bin/zsh", ["-c", "lsappinfo info -only bundleid $(lsappinfo front)"])).stdout.match(/="([^"]+)"/)?.[1];
let isPolling = true;
void (async () => {
  let last;
  while (isPolling) {
    const now = await front();
    if (now !== last) console.log(`${stamp()} front ${now}`);
    last = now;
  }
})();

const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<title>opener</title>
<a id="blank" href="/child" target="_blank">blank</a>
<button id="open" onclick="window.open('/child')">open</button>
<button id="win" onclick="window.open('/child', '', 'width=400,height=300')">win</button>`);
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "spike8-")), {
  channel: "chrome",
  headless: false,
  viewport: null,
  chromiumSandbox: true,
});
context.on("page", () => console.log(`${stamp()} page event`));
const page = context.pages()[0];
await page.goto(origin);
for (const id of ["blank", "open", "win"]) {
  execFileSync("open", ["-a", "TextEdit"]);
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`${stamp()} click #${id}`);
  await page.click(`#${id}`);
  await new Promise((r) => setTimeout(r, 2500));
}
isPolling = false;
await context.close();
server.close();
