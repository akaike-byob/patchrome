// Spike 9: per-domain HTTPS proxies set by an extension, with extension-answered proxy auth.
// Usage: DEBUG=pw:protocol node spikes/09-proxy-extension.mjs <workDir> [--headed] [--untrusted-cert] 2> <protocol.log>
import { chromium } from "patchright";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { makeCertificate, startProxy, startTargets } from "./proxy-fixtures.mjs";

const workDir = resolve(process.argv[2]);
const isHeaded = process.argv.includes("--headed");
// Without the SPKI entry Chrome must reject the proxies' self-signed certificate, which shows it checks proxy TLS.
const isCertTrusted = !process.argv.includes("--untrusted-cert");
const extensionDir = fileURLToPath(new URL("./proxy-extension", import.meta.url));
const report = (step, data) => console.log(JSON.stringify({ step, ...data }));

const tls = makeCertificate(join(workDir, "tls"));
const targets = await startTargets(tls);
const proxyA = await startProxy({ name: "A", ...tls, username: "alice", password: "pa", targets });
const proxyB = await startProxy({ name: "B", ...tls, username: "bob", password: "pb", targets });
// C and D are never used before their tests, so Chrome has no cached credentials for them.
const proxyC = await startProxy({ name: "C", ...tls, username: "carol", password: "pc", targets });
const proxyD = await startProxy({ name: "D", ...tls, username: "dave", password: "pd", targets });
const proxies = [proxyA, proxyB, proxyC, proxyD];
const carrierOf = (clientPort) => proxies.find((p) => p.log.some((e) => e.upstreamPort === clientPort))?.name ?? "none";

const context = await chromium.launchPersistentContext(mkdtempSync(join(workDir, "profile-")), {
  channel: "chrome",
  headless: !isHeaded,
  viewport: null,
  chromiumSandbox: true,
  args: [
    "--enable-unsafe-extension-debugging",
    ...(isCertTrusted ? [`--ignore-certificate-errors-spki-list=${tls.spkiHash}`] : []),
  ],
});
const browserCdp = await context.browser().newBrowserCDPSession();
const { id: extensionId } = await browserCdp.send("Extensions.loadUnpacked", { path: extensionDir });
const worker =
  context.serviceWorkers().find((w) => w.url().includes(extensionId)) ??
  (await context.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(extensionId), timeout: 10_000 }));
// Main world, where the worker's globals live.
const inWorker = (fn, arg) => worker.evaluate.call(worker, fn, arg, false);
report("extension", { extensionId, isReady: await inWorker(() => spikeIsReady()) });

const pac = (rules) => `function FindProxyForURL(url, host) {
  var rules = ${JSON.stringify(rules)};
  if (rules[host]) return rules[host];
  return "DIRECT";
}`;
const viaA = `HTTPS 127.0.0.1:${proxyA.port}`;
const viaB = `HTTPS 127.0.0.1:${proxyB.port}`;
await inWorker(
  (c) => {
    spikeCredentials = c;
  },
  {
    [`127.0.0.1:${proxyA.port}`]: { username: "alice", password: "pa" },
    [`127.0.0.1:${proxyB.port}`]: { username: "bob", password: "pb" },
    [`127.0.0.1:${proxyC.port}`]: { username: "carol", password: "pc" },
    [`127.0.0.1:${proxyD.port}`]: { username: "dave", password: "wrong" },
  },
);

const page = context.pages()[0] ?? (await context.newPage());
const load = async (url, onPage = page) => {
  // A failed load leaves a chrome-error commit behind that interrupts the next goto.
  for (let attempt = 1; ; attempt++) {
    try {
      await onPage.goto("about:blank");
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(300);
    }
  }
  const before = targets.requests.length;
  const failures = [];
  const onFailed = (req) => failures.push(req.failure()?.errorText);
  onPage.on("requestfailed", onFailed);
  try {
    await onPage.goto(url, { timeout: 10_000 });
    const hit = targets.requests.slice(before).find((r) => url.includes(r.host));
    return {
      url,
      ok: true,
      carrier: hit ? carrierOf(hit.clientPort) : "no target request",
      httpVersion: hit?.httpVersion,
    };
  } catch (err) {
    return { url, ok: false, error: err.message.split("\n")[0], failures };
  } finally {
    onPage.off("requestfailed", onFailed);
  }
};
const drainEvents = () => inWorker(() => spikeEvents.splice(0));

// Spike 2 and 3: PAC with two HTTPS proxies, auth answered per challenger.
const settings = await inWorker((a) => spikeSetPac(a), {
  pac: pac({ "a.spike.test": viaA, "b.spike.test": viaB, "c.spike.test": viaA }),
  mandatory: true,
});
report("pac-set", { levelOfControl: settings.levelOfControl, mode: settings.value.mode });
report("https-via-A", await load("https://a.spike.test/one"));
report("http-via-A", await load("http://a.spike.test/plain"));
report("https-via-B", await load("https://b.spike.test/one"));
report("direct-unmatched", await load("https://unmatched.spike.test/"));
report("auth-events", { events: await drainEvents() });

// Spike 4: a rule change while an HTTP/2 tunnel to c.spike.test through A is open.
report("c-before-swap", await load("https://c.spike.test/before"));
await inWorker((a) => spikeSetPac(a), {
  pac: pac({ "a.spike.test": viaA, "b.spike.test": viaB, "c.spike.test": viaB }),
  mandatory: true,
});
const beforeFetch = targets.requests.length;
const fetched = await page.evaluate(() =>
  fetch("/after-fetch").then(
    (r) => r.status,
    (e) => String(e),
  ),
);
const fetchHit = targets.requests.slice(beforeFetch)[0];
report("c-fetch-after-swap", {
  status: fetched,
  carrier: fetchHit ? carrierOf(fetchHit.clientPort) : "no target request",
});
report("c-nav-after-swap", await load("https://c.spike.test/after-nav"));
await sleep(500);
report("c-nav-after-swap-500ms", await load("https://c.spike.test/after-nav-2"));

// Spike 1: patchright request interception on the page, the way routes.ts installs a rule, on a proxy never used.
const rules = {
  "a.spike.test": viaA,
  "b.spike.test": viaB,
  "routed.spike.test": `HTTPS 127.0.0.1:${proxyC.port}`,
  "wrong.spike.test": `HTTPS 127.0.0.1:${proxyD.port}`,
  "dead.spike.test": "HTTPS 127.0.0.1:1",
  "rotated-1.spike.test": viaA,
  "rotated-2.spike.test": viaA,
};
await inWorker((a) => spikeSetPac(a), { pac: pac(rules), mandatory: true });
const routedPage = await context.newPage();
await routedPage.route("**/never-matches-*", (route) => route.fallback());
report("with-page-route-fresh-proxy", await load("https://routed.spike.test/routed", routedPage));
report("with-page-route-events", { events: await drainEvents() });
await routedPage.close();

// Failure modes: wrong password on a fresh proxy, rotated password on a used one, dead proxy, a PAC that throws.
const freshPage = await context.newPage();
report("wrong-password", await load("https://wrong.spike.test/wrong", freshPage));
report("wrong-password-events", { events: await drainEvents() });
proxyA.setPassword("pa2");
report("rotated-server-only", await load("https://rotated-1.spike.test/rotated-server-only", freshPage));
report("rotated-server-only-events", { events: await drainEvents() });
await inWorker(
  (c) => {
    spikeCredentials[c.key] = c.value;
  },
  { key: `127.0.0.1:${proxyA.port}`, value: { username: "alice", password: "pa2" } },
);
report("rotated-both", await load("https://rotated-2.spike.test/rotated-both", freshPage));
report("rotated-both-events", { events: await drainEvents() });
report("dead-proxy", await load("https://dead.spike.test/", freshPage));
report("dead-proxy-events", { events: await drainEvents() });
const throwingPac = "function FindProxyForURL(url, host) { throw new Error('boom'); }";
await inWorker((a) => spikeSetPac(a), { pac: throwingPac, mandatory: true });
report("throwing-pac-mandatory", await load("https://a.spike.test/throwing-mandatory", freshPage));
await inWorker((a) => spikeSetPac(a), { pac: throwingPac, mandatory: false });
report("throwing-pac-not-mandatory", await load("https://a.spike.test/throwing-optional", freshPage));
report("throwing-pac-events", { events: (await drainEvents()).slice(0, 2) });
await freshPage.close();

// Spike 5: WebRTC candidates before and after the privacy policy.
await inWorker((a) => spikeSetPac(a), { pac: pac({ "a.spike.test": viaA }), mandatory: true });
await page.goto("https://a.spike.test/webrtc");
const candidates = () =>
  page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("x");
    const found = [];
    pc.onicecandidate = (e) => e.candidate && found.push(e.candidate.candidate);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 2000));
    pc.close();
    return found;
  });
report("webrtc-default", { candidates: await candidates() });
report("webrtc-policy", { setting: await inWorker((a) => spikeSetWebRtc(a), "disable_non_proxied_udp") });
report("webrtc-after-policy", { candidates: await candidates() });

// Spike 6: what a page can see.
report("page-view", {
  fingerprint: await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    chromeKeys: Object.keys(window.chrome ?? {}),
    hasRuntimeId: Boolean(window.chrome?.runtime?.id),
  })),
});

await context.close();
proxies.forEach((p) => p.close());
targets.close();
report("proxy-logs", Object.fromEntries(proxies.map((p) => [p.name, p.log.filter((e) => e.event !== "forward")])));
