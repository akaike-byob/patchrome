// Spike 9 driver: the spike sets globals through the worker, and reads what Chrome reported back.
globalThis.spikeEvents = [];
globalThis.spikeCredentials = {};
const attempts = new Map();

chrome.webRequest.onAuthRequired.addListener(
  (details, respond) => {
    const key = `${details.challenger.host}:${details.challenger.port}`;
    const attempt = (attempts.get(details.requestId) ?? 0) + 1;
    attempts.set(details.requestId, attempt);
    spikeEvents.push({
      event: "authRequired",
      isProxy: details.isProxy,
      challenger: key,
      tabId: details.tabId,
      url: details.url,
      attempt,
    });
    const credentials = spikeCredentials[key];
    if (!details.isProxy || !credentials || attempt > 1) return respond({ cancel: true });
    respond({ authCredentials: credentials });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

chrome.proxy.onProxyError.addListener((details) => spikeEvents.push({ event: "proxyError", ...details }));

globalThis.spikeSetPac = async ({ pac, mandatory }) => {
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: pac, mandatory } },
    scope: "regular",
  });
  return chrome.proxy.settings.get({});
};
globalThis.spikeClearProxy = () => chrome.proxy.settings.clear({ scope: "regular" });
globalThis.spikeSetWebRtc = async (value) => {
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value });
  return chrome.privacy.network.webRTCIPHandlingPolicy.get({});
};
globalThis.spikeIsReady = () => true;
