// Can Patchright give console, page errors, tracing and a TCP debugging port once instrumentation is on?
import { chromium } from "patchright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync(join(process.cwd(), "scratch/spike07-"));
const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: false, viewport: null, chromiumSandbox: true, args: ["--remote-debugging-port=0"] });
const page = ctx.pages()[0] ?? await ctx.newPage();
const seen = { console: [], pageerror: [], cdpConsole: [], cdpException: [] };
page.on("console", (m) => seen.console.push(m.text()));
page.on("pageerror", (e) => seen.pageerror.push(e.message));
const cdp = await ctx.newCDPSession(page);
cdp.on("Runtime.consoleAPICalled", (e) => seen.cdpConsole.push(e.type + " " + e.args.map((a) => a.value ?? a.description).join(" ")));
cdp.on("Runtime.exceptionThrown", (e) => seen.cdpException.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
await cdp.send("Runtime.enable");
let traced = "no";
try { await ctx.tracing.start({ screenshots: false, snapshots: true }); traced = "started"; } catch (e) { traced = "start failed " + e.message; }
await page.goto("data:text/html,<script>console.log('hi', 42); console.error('bad'); setTimeout(() => { throw new Error('boom') }, 10)</script>");
await page.waitForTimeout(500);
try { await ctx.tracing.stop({ path: join(dir, "trace.zip") }); traced += ", stopped " + existsSync(join(dir, "trace.zip")); } catch (e) { traced += ", stop failed " + e.message; }
const portFile = join(dir, "DevToolsActivePort");
const port = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n")[0] : "none";
let version = "none";
if (port !== "none") version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
console.log(JSON.stringify({ ...seen, traced, port, version }, null, 1));
await ctx.close();
