// Chrome takes focus when it launches. Can the daemon hand focus back without Apple Events permission?
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";

const front = (field) =>
  execFileSync("zsh", ["-c", `lsappinfo info -only ${field} $(lsappinfo front)`], { encoding: "utf8" })
    .trim()
    .replace(/.*="?([^"]*)"?$/, "$1");
const before = front("bundleid");
const log = [];
const poll = setInterval(() => {
  const b = front("bundleid");
  if (log.at(-1)?.[1] !== b) log.push([Date.now(), b]);
}, 20);
const started = Date.now();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "focus-")), {
  channel: "chrome",
  headless: false,
  viewport: null,
  chromiumSandbox: true,
});
const launchedAt = Date.now();
execFileSync("open", ["-b", before]);
await new Promise((r) => setTimeout(r, 3000));
clearInterval(poll);
console.log("before", before, "launched +", launchedAt - started);
console.log(log.map(([t, b]) => `+${t - started} ${b}`).join("\n"));
await context.close();
