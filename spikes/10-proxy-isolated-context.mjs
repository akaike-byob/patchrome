// Spike 10: do extension proxy rules and extension proxy auth reach an isolated CDP browser context?
// Usage: node spikes/10-proxy-isolated-context.mjs <workDir>
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCertificate, startProxy, startTargets } from "./proxy-fixtures.mjs";

const workDir = resolve(process.argv[2]);
const extensionDir = fileURLToPath(new URL("./proxy-extension", import.meta.url));
const report = (step, data) => console.log(JSON.stringify({ step, ...data }));
const tls = makeCertificate(join(workDir, "tls"));
const targets = await startTargets(tls);
const withAuth = await startProxy({ name: "auth", ...tls, username: "alice", password: "pa", targets });
const noAuth = await startProxy({ name: "open", ...tls, username: "x", password: "x", targets });
noAuth.setPassword(undefined);

const context = await chromium.launchPersistentContext(mkdtempSync(join(workDir, "profile-")), {
  channel: "chrome",
  headless: true,
  viewport: null,
  chromiumSandbox: true,
  args: ["--enable-unsafe-extension-debugging", `--ignore-certificate-errors-spki-list=${tls.spkiHash}`],
});
const browserCdp = await context.browser().newBrowserCDPSession();
const { id } = await browserCdp.send("Extensions.loadUnpacked", { path: extensionDir });
const worker =
  context.serviceWorkers().find((w) => w.url().includes(id)) ??
  (await context.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(id) }));
const inWorker = (fn, arg) => worker.evaluate.call(worker, fn, arg, false);
await inWorker(
  (c) => {
    spikeCredentials = c;
  },
  { [`127.0.0.1:${withAuth.port}`]: { username: "alice", password: "pa" } },
);
const pac = `function FindProxyForURL(url, host) {
  if (host == "auth.spike.test") return "HTTPS 127.0.0.1:${withAuth.port}";
  if (host == "open.spike.test") return "HTTPS 127.0.0.1:${noAuth.port}";
  return "DIRECT";
}`;
await inWorker((a) => spikeSetPac(a), { pac, mandatory: true });

const { browserContextId } = await browserCdp.send("Target.createBrowserContext", {});
const load = async (url) => {
  const pagePromise = context.waitForEvent("page");
  await browserCdp.send("Target.createTarget", { url: "about:blank", browserContextId, background: true });
  const page = await pagePromise;
  const before = targets.requests.length;
  try {
    await page.goto(url, { timeout: 10_000 });
    return { url, ok: true, reachedTarget: targets.requests.length > before };
  } catch (err) {
    return { url, ok: false, error: err.message.split("\n")[0] };
  } finally {
    await page.close();
  }
};
report("isolated-open-proxy", await load("https://open.spike.test/"));
report("isolated-auth-proxy", await load("https://auth.spike.test/"));
report("isolated-unmatched", await load("https://unmatched.spike.test/"));
report("extension-events", { events: await inWorker(() => spikeEvents.splice(0)) });
report("proxy-logs", {
  auth: withAuth.log.map((e) => `${e.event} ${e.url ?? e.target} ${e.ok ?? ""}`),
  open: noAuth.log.map((e) => `${e.event} ${e.url ?? e.target} ${e.ok ?? ""}`),
});
await context.close();
process.exit(0);
