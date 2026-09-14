// The daemon calls these through its service worker handle. The extension injects nothing into pages.
// Credentials live in chrome.storage.session: in memory only, and still there when Chrome restarts the worker.

const recentFailureLimit = 50;
const attemptsByRequest = new Map();

async function recordFailure(failure) {
  const { failures = [] } = await chrome.storage.session.get("failures");
  await chrome.storage.session.set({
    failures: [...failures, { ...failure, atMs: Date.now() }].slice(-recentFailureLimit),
  });
}

// Chrome tries a cached password first, then asks here. A second ask for one request means the proxy refused
// what this handler gave, so it cancels instead of looping.
chrome.webRequest.onAuthRequired.addListener(
  (details, respond) => {
    void (async () => {
      if (!details.isProxy) return respond({});
      const challenger = `${details.challenger.host}:${details.challenger.port}`;
      const attempt = (attemptsByRequest.get(details.requestId) ?? 0) + 1;
      attemptsByRequest.set(details.requestId, attempt);
      const { credentials = [] } = await chrome.storage.session.get("credentials");
      const credential = credentials.find((candidate) => candidate.challenger === challenger);
      if (credential === undefined || attempt > 1) {
        await recordFailure({
          kind: credential === undefined ? "no_credentials" : "auth_refused",
          challenger,
          url: details.url,
        });
        return respond({ cancel: true });
      }
      respond({ authCredentials: { username: credential.username, password: credential.password } });
    })();
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

chrome.webRequest.onCompleted.addListener((details) => attemptsByRequest.delete(details.requestId), {
  urls: ["<all_urls>"],
});
chrome.webRequest.onErrorOccurred.addListener((details) => attemptsByRequest.delete(details.requestId), {
  urls: ["<all_urls>"],
});

chrome.proxy.onProxyError.addListener((details) => {
  void recordFailure({ kind: "proxy_error", error: details.error, detail: details.details });
});

// mandatory: a PAC script that fails stops requests instead of sending them straight to the site.
// The WebRTC policy keeps pages from reaching the network over UDP, which no proxy carries.
globalThis.patchromeApplyProxyRules = async (rules) => {
  if (rules === undefined || rules === null) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    await chrome.storage.session.remove("credentials");
    return;
  }
  await chrome.storage.session.set({ credentials: rules.credentials });
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: rules.pacScript, mandatory: true } },
    scope: "regular",
  });
  const applied = await chrome.proxy.settings.get({});
  if (applied.levelOfControl !== "controlled_by_this_extension")
    throw new Error(
      `Chrome kept its own proxy settings (${applied.levelOfControl}); a policy or another extension controls them`,
    );
};

globalThis.patchromeRecentProxyFailures = async ({ sinceMs }) => {
  const { failures = [] } = await chrome.storage.session.get("failures");
  return failures.filter((failure) => failure.atMs >= sinceMs);
};

globalThis.patchromeTimeZone = async () => Intl.DateTimeFormat().resolvedOptions().timeZone;
