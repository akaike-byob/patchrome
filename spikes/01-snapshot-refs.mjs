// Spike 1: does Playwright's AI-mode aria snapshot with refs survive Patchright's isolated worlds?
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = `<!doctype html><title>fixture</title>
<h1>Login</h1>
<form onsubmit="event.preventDefault(); document.querySelector('#out').textContent='sent:'+this.u.value">
  <label>User <input name="u"></label>
  <button>Sign in</button>
</form>
<a href="#x">Help</a><p id="out"></p>
<div id="shadow-host"></div>
<script>document.querySelector('#shadow-host').attachShadow({mode:'closed'}).innerHTML='<button>Shadow btn</button>'</script>`;

const profileDir = mkdtempSync(join(tmpdir(), "spike1-"));
const context = await chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: false, viewport: null, chromiumSandbox: true });
const page = await context.newPage();
await page.setContent(html);

const snapshot = await page._snapshotForAI?.() ?? await page.locator("body").ariaSnapshot({ mode: "ai" });
const snapshotText = typeof snapshot === "string" ? snapshot : snapshot.full;
console.log("--- snapshot ---\n" + snapshotText);

const refs = [...snapshotText.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
console.log("ref count:", refs.length);

const textboxRef = snapshotText.match(/textbox "User" \[ref=(e\d+)\]/)?.[1];
const buttonRef = snapshotText.match(/button "Sign in" \[ref=(e\d+)\]/)?.[1];
await page.locator(`aria-ref=${textboxRef}`).fill("alice");
await page.locator(`aria-ref=${buttonRef}`).click();
console.log("after act:", await page.locator("#out").textContent());

const shadowRef = snapshotText.match(/button "Shadow btn" \[ref=(e\d+)\]/)?.[1];
console.log("closed shadow button ref:", shadowRef ?? "absent");

await page.setContent(html);
try {
  await page.locator(`aria-ref=${buttonRef}`).click({ timeout: 2000 });
  console.log("stale ref after navigation: still resolves");
} catch (err) {
  console.log("stale ref after navigation:", err.message.split("\n")[0]);
}
await context.close();
