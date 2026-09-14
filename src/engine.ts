import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Cookie,
  type LaunchOptions,
  type Page,
  type Worker,
} from "patchright";
import { chromeUserDataDirFrom } from "./chrome-profiles.ts";
import { keepFocusDuring } from "./focus.ts";
import { CommandError } from "./protocol.ts";
import type { HostPlatform } from "./host-platform.ts";
import { readOriginStorageInPage, type OriginStorage } from "./origin-storage.ts";
import type { ProfileMode } from "./profile-mode.ts";
import type { ProxyRulesForChrome } from "./proxy-rules.ts";
import type { TabGroupColor, TabGroupSummary } from "./tab-groups.ts";
import {
  findWindowsChrome,
  requireMirroredNetworking,
  windowsChromeProfileDirFor,
  windowsPathOf,
  writeChromeLauncher,
  type WindowsChrome,
} from "./windows-chrome.ts";

// Where Chrome runs. On WSL it is the Windows Chrome, reached through a relay; see windows-chrome.ts.
export const chromeHosts = ["local", "windows"] as const;
export type ChromeHost = (typeof chromeHosts)[number];

export function chromeHostFor(platform: HostPlatform): ChromeHost {
  switch (platform) {
    case "wsl":
      return "windows";
    case "macos":
    case "linux":
    case "unsupported":
      return "local";
  }
}

export interface DebuggingEndpoint {
  httpUrl: string;
  browserWsUrl: string;
}

// The daemon talks to the browser only through this interface, so a different Playwright-compatible
// stealth engine can replace Patchright without touching sessions or commands.
export interface BrowserEngine {
  launch(chromeProfileDir: string, mode: ProfileMode): Promise<void>;
  // The user data dir the launched Chrome runs on. On WSL it is a twin of chromeProfileDir on the Windows disk.
  userDataDir(): string;
  // The Chrome user data dir a state import reads: the one named, else the everyday Chrome's.
  importChromeUserDataDir(named: string | undefined): Promise<string>;
  // An empty dir for a copy of an everyday Chrome profile, where this engine's Chrome can open it.
  makeProfileCopyDir(): Promise<string>;
  // browserContextId picks an isolated context; undefined means the persistent profile.
  openBackgroundPage(browserContextId?: string): Promise<Page>;
  // Brings Chrome forward on purpose, for a person to use the tab.
  openForegroundPage(browserContextId?: string): Promise<Page>;
  cookies(urls: string[] | undefined, browserContextId?: string): Promise<Cookie[]>;
  addCookies(cookies: Cookie[], browserContextId?: string): Promise<void>;
  createIsolatedContext(): Promise<string>;
  disposeIsolatedContext(browserContextId: string): Promise<void>;
  // Puts the pages in one Chrome tab group per window, titled and coloured as given.
  groupTabs(pages: Page[], title: string, color: TabGroupColor): Promise<void>;
  describeTabGroups(pages: Page[]): Promise<TabGroupSummary[]>;
  // Undefined turns proxy rules off. Isolated contexts never see these rules: Chrome keeps extensions out of them.
  applyProxyRules(rules: ProxyRulesForChrome | undefined): Promise<void>;
  // Proxy refusals and errors the extension saw since the time given.
  recentProxyFailures(sinceMs: number): Promise<ProxyFailure[]>;
  chromeTimeZone(): Promise<string>;
  // Debug profile only; a stealth launch has no port, so this is undefined.
  // Opens a copied Chrome user data dir in a separate headless Chrome, with no network, and reads its cookies
  // and each origin's storage.
  readProfileCopy(copyUserDataDir: string, origins: string[]): Promise<{ cookies: Cookie[]; origins: OriginStorage[] }>;
  debuggingEndpoint(): DebuggingEndpoint | undefined;
  openCdpSession(page: Page): Promise<CDPSession>;
  startTrace(): Promise<void>;
  stopTrace(path: string): Promise<void>;
  onClosed(listener: () => void): void;
  close(): Promise<void>;
}

export type ProxyFailure =
  | { kind: "auth_refused" | "no_credentials"; challenger: string; url: string; atMs: number }
  | { kind: "proxy_error"; error: string; detail: string; atMs: number };

const pageOpenTimeoutMs = 15_000;
// Chrome activates 400-800ms into launch, before launch resolves. A longer grace sends the user's own
// Dock clicks on Chrome back to the previous app.
const focusGraceMs = 500;
const devToolsPortWaitMs = 10_000;
const extensionWorkerWaitMs = 10_000;
// src/ and dist/ both sit one level below the package root, next to extension/.
const tabGroupsExtensionDir = fileURLToPath(new URL("../extension/tab-groups", import.meta.url));
const proxyRulesExtensionDir = fileURLToPath(new URL("../extension/proxy-rules", import.meta.url));

export class PatchrightEngine implements BrowserEngine {
  #chromeHost: ChromeHost;
  #windowsChrome: Promise<{ found: WindowsChrome; launcherPath: string }> | undefined;
  #context: BrowserContext | undefined;
  #browserCdp: CDPSession | undefined;
  #closedListeners: Array<() => void> = [];
  #endpoint: DebuggingEndpoint | undefined;
  #tabGroupsExtensionId: string | undefined;
  #proxyRulesExtensionId: string | undefined;
  #targetIdByPage = new WeakMap<Page, Promise<string>>();
  #userDataDir: string | undefined;
  #isHeadless: boolean;
  #trustedSpkiHashes: string[];

  // trustedSpkiHashes lets integration tests run HTTPS proxies on self-signed certificates. Only code in the
  // daemon's own process can pass it; the __daemon entrypoint passes none.
  constructor({
    chromeHost,
    isHeadless,
    trustedSpkiHashes = [],
  }: {
    chromeHost: ChromeHost;
    isHeadless: boolean;
    trustedSpkiHashes?: string[];
  }) {
    this.#chromeHost = chromeHost;
    this.#isHeadless = isHeadless;
    this.#trustedSpkiHashes = trustedSpkiHashes;
  }

  async launch(chromeProfileDir: string, mode: ProfileMode): Promise<void> {
    switch (this.#chromeHost) {
      case "local":
        break;
      case "windows":
        await requireMirroredNetworking();
        // Asking PowerShell where Chrome is takes most of a second, so the daemon asks once.
        this.#windowsChrome = findWindowsChrome().then(async (found) => ({
          found,
          launcherPath: await writeChromeLauncher(chromeProfileDir, found),
        }));
        break;
    }
    const userDataDir = await this.#userDataDirFor(chromeProfileDir);
    this.#userDataDir = userDataDir;
    // A port file left by an earlier Chrome would point at a dead port.
    await rm(join(userDataDir, "DevToolsActivePort"), { force: true });
    const launched = chromium.launchPersistentContext(userDataDir, {
      ...(await this.#chromeExecutable()),
      headless: this.#isHeadless,
      viewport: null,
      // Without this Playwright passes --no-sandbox, which weakens Chrome and shows a warning bar.
      chromiumSandbox: true,
      args: [
        ...launchArgsFor(mode),
        ...(this.#trustedSpkiHashes.length === 0
          ? []
          : [`--ignore-certificate-errors-spki-list=${this.#trustedSpkiHashes.join(",")}`]),
      ],
    });
    const context = this.#isHeadless ? await launched : await keepFocusDuring(launched, focusGraceMs);
    context.on("close", () => {
      for (const listener of this.#closedListeners) listener();
    });
    const browser = context.browser();
    if (!browser) throw new Error("persistent context exposed no browser for a browser-level CDP session");
    this.#browserCdp = await browser.newBrowserCDPSession();
    this.#context = context;
    const { id } = await this.#browserCdp.send("Extensions.loadUnpacked", {
      path: await this.#pathForChrome(tabGroupsExtensionDir),
    });
    this.#tabGroupsExtensionId = id;
    const { id: proxyRulesId } = await this.#browserCdp.send("Extensions.loadUnpacked", {
      path: await this.#pathForChrome(proxyRulesExtensionDir),
    });
    this.#proxyRulesExtensionId = proxyRulesId;
    switch (mode) {
      case "stealth":
        break;
      case "debug":
        this.#endpoint = await readDevToolsEndpoint(userDataDir);
        break;
    }
  }

  async importChromeUserDataDir(named: string | undefined): Promise<string> {
    switch (this.#chromeHost) {
      case "local":
        return named ?? chromeUserDataDirFrom({});
      case "windows": {
        if (named === undefined) {
          return join((await this.#requireWindowsChrome()).found.localAppDataDir, "Google", "Chrome", "User Data");
        }
        // Chrome encrypts cookies with a key only the same OS can read, so the Windows Chrome drops a Linux
        // Chrome's cookies. wslpath maps a dir inside WSL to a \\wsl.localhost UNC path.
        if ((await windowsPathOf(named)).startsWith("\\\\")) {
          throw new CommandError(
            "bad_args",
            `${named} is inside WSL; on WSL patchrome imports from the Windows Chrome, which cannot decrypt a Linux Chrome's cookies`,
            "point PATCHROME_CHROME_USER_DATA_DIR at a Windows Chrome user data dir under /mnt, or unset it",
          );
        }
        return named;
      }
    }
  }

  async makeProfileCopyDir(): Promise<string> {
    switch (this.#chromeHost) {
      case "local":
        return mkdtemp(join(tmpdir(), "patchrome-login-copy-"));
      case "windows": {
        const copiesDir = join((await this.#requireWindowsChrome()).found.localAppDataDir, "patchrome", "login-copies");
        await mkdir(copiesDir, { recursive: true });
        return mkdtemp(join(copiesDir, "patchrome-login-copy-"));
      }
    }
  }

  async openBackgroundPage(browserContextId?: string): Promise<Page> {
    return this.#openTarget(true, browserContextId);
  }

  async openForegroundPage(browserContextId?: string): Promise<Page> {
    if (browserContextId === undefined) return this.#requireContext().newPage();
    return this.#openTarget(false, browserContextId);
  }

  // Playwright does not know isolated contexts and files their pages under the persistent one, so
  // context.cookies() would read the wrong jar. CDP Storage takes the context id.
  async cookies(urls: string[] | undefined, browserContextId?: string): Promise<Cookie[]> {
    if (browserContextId === undefined) return this.#requireContext().cookies(urls);
    const { cookies } = await this.#requireBrowserCdp().send("Storage.getCookies", { browserContextId });
    return cookies
      .map(playwrightCookieOf)
      .filter((cookie) => urls === undefined || urls.some((url) => cookieAppliesTo(cookie, url)));
  }

  async addCookies(cookies: Cookie[], browserContextId?: string): Promise<void> {
    if (browserContextId === undefined) return this.#requireContext().addCookies(cookies);
    await this.#requireBrowserCdp().send("Storage.setCookies", {
      browserContextId,
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
      })),
    });
  }

  async createIsolatedContext(): Promise<string> {
    const { browserContextId } = await this.#requireBrowserCdp().send("Target.createBrowserContext", {});
    return browserContextId;
  }

  async disposeIsolatedContext(browserContextId: string): Promise<void> {
    await this.#requireBrowserCdp().send("Target.disposeBrowserContext", { browserContextId });
  }

  async groupTabs(pages: Page[], title: string, color: TabGroupColor): Promise<void> {
    const targetIds = await Promise.all(pages.map((page) => this.#targetIdOf(page)));
    const worker = await this.#extensionWorker(this.#tabGroupsExtensionId);
    await evaluateInWorker(
      worker,
      (request) => (globalThis as unknown as TabGroupsWorker).patchromeGroupTabs(request),
      { targetIds, title, color },
    );
  }

  async describeTabGroups(pages: Page[]): Promise<TabGroupSummary[]> {
    const targetIds = await Promise.all(pages.map((page) => this.#targetIdOf(page)));
    const worker = await this.#extensionWorker(this.#tabGroupsExtensionId);
    return evaluateInWorker(
      worker,
      (request) => (globalThis as unknown as TabGroupsWorker).patchromeDescribeTabGroups(request),
      { targetIds },
    );
  }

  async applyProxyRules(rules: ProxyRulesForChrome | undefined): Promise<void> {
    const worker = await this.#extensionWorker(this.#proxyRulesExtensionId);
    await evaluateInWorker(
      worker,
      (arg) => (globalThis as unknown as ProxyRulesWorker).patchromeApplyProxyRules(arg ?? undefined),
      rules ?? null,
    );
  }

  async recentProxyFailures(sinceMs: number): Promise<ProxyFailure[]> {
    const worker = await this.#extensionWorker(this.#proxyRulesExtensionId);
    return evaluateInWorker(
      worker,
      (arg) => (globalThis as unknown as ProxyRulesWorker).patchromeRecentProxyFailures(arg),
      { sinceMs },
    );
  }

  async chromeTimeZone(): Promise<string> {
    const worker = await this.#extensionWorker(this.#proxyRulesExtensionId);
    return evaluateInWorker(worker, () => (globalThis as unknown as ProxyRulesWorker).patchromeTimeZone(), undefined);
  }

  async readProfileCopy(
    copyUserDataDir: string,
    origins: string[],
  ): Promise<{ cookies: Cookie[]; origins: OriginStorage[] }> {
    const reader = await chromium.launchPersistentContext(copyUserDataDir, {
      ...(await this.#chromeExecutable()),
      headless: true,
      // The everyday profile encrypts cookies with the OS credential store. Under Playwright's mock store Chrome
      // cannot decrypt them and deletes them from the copy.
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    });
    try {
      await reader.route("**/*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>patchrome import</title>",
        }),
      );
      const cookies = await reader.cookies();
      const page = await reader.newPage();
      const storage: OriginStorage[] = [];
      for (const origin of origins) {
        await page.goto(`${origin}/`, { waitUntil: "commit" });
        storage.push({ origin, ...(await page.evaluate(readOriginStorageInPage, undefined, undefined, true)) });
      }
      return { cookies, origins: storage };
    } finally {
      await reader.close();
    }
  }

  debuggingEndpoint(): DebuggingEndpoint | undefined {
    return this.#endpoint;
  }

  async openCdpSession(page: Page): Promise<CDPSession> {
    return this.#requireContext().newCDPSession(page);
  }

  async startTrace(): Promise<void> {
    await this.#requireContext().tracing.start({ screenshots: true, snapshots: true });
  }

  async stopTrace(path: string): Promise<void> {
    await this.#requireContext().tracing.stop({ path });
  }

  onClosed(listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  async close(): Promise<void> {
    await this.#context?.close();
  }

  // The Windows Chrome keeps its profile on the Windows disk; the Linux profile dir holds only the launcher.
  userDataDir(): string {
    if (this.#userDataDir === undefined) throw new Error("engine not launched");
    return this.#userDataDir;
  }

  async #userDataDirFor(chromeProfileDir: string): Promise<string> {
    switch (this.#chromeHost) {
      case "local":
        return chromeProfileDir;
      case "windows": {
        const { found } = await this.#requireWindowsChrome();
        const userDataDir = windowsChromeProfileDirFor(found, chromeProfileDir, process.env.WSL_DISTRO_NAME);
        await mkdir(userDataDir, { recursive: true });
        return userDataDir;
      }
    }
  }

  async #chromeExecutable(): Promise<Pick<LaunchOptions, "channel" | "executablePath">> {
    switch (this.#chromeHost) {
      case "local":
        return { channel: "chrome" };
      case "windows":
        return { executablePath: (await this.#requireWindowsChrome()).launcherPath };
    }
  }

  async #pathForChrome(path: string): Promise<string> {
    switch (this.#chromeHost) {
      case "local":
        return path;
      case "windows":
        return windowsPathOf(path);
    }
  }

  #requireWindowsChrome(): Promise<{ found: WindowsChrome; launcherPath: string }> {
    if (!this.#windowsChrome) throw new Error("engine not launched");
    return this.#windowsChrome;
  }

  // context.newPage() activates Chrome on macOS; a background CDP target does not. The unique about:blank
  // fragment ties the `page` event back to this call when several sessions open tabs at once.
  async #openTarget(isBackground: boolean, browserContextId: string | undefined): Promise<Page> {
    const context = this.#requireContext();
    const marker = `about:blank#patchrome-${randomUUID()}`;
    const pagePromise = context.waitForEvent("page", {
      predicate: (page) => page.url() === marker,
      timeout: pageOpenTimeoutMs,
    });
    await this.#requireBrowserCdp().send("Target.createTarget", {
      url: marker,
      background: isBackground,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    });
    return pagePromise;
  }

  // The extension API names tabs by its own ids; CDP target ids are the only id both sides share.
  #targetIdOf(page: Page): Promise<string> {
    let targetId = this.#targetIdByPage.get(page);
    if (targetId === undefined) {
      targetId = this.openCdpSession(page).then(async (cdp) => {
        try {
          return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
        } finally {
          await cdp.detach().catch(() => {});
        }
      });
      this.#targetIdByPage.set(page, targetId);
    }
    return targetId;
  }

  async #extensionWorker(extensionId: string | undefined): Promise<Worker> {
    const context = this.#requireContext();
    if (extensionId === undefined) throw new Error("engine not launched");
    const prefix = `chrome-extension://${extensionId}/`;
    const isExtensionWorker = (worker: Worker) => worker.url().startsWith(prefix);
    return (
      context.serviceWorkers().find(isExtensionWorker) ??
      context.waitForEvent("serviceworker", { predicate: isExtensionWorker, timeout: extensionWorkerWaitMs })
    );
  }

  #requireContext(): BrowserContext {
    if (!this.#context) throw new Error("engine not launched");
    return this.#context;
  }

  #requireBrowserCdp(): CDPSession {
    if (!this.#browserCdp) throw new Error("engine not launched");
    return this.#browserCdp;
  }
}

// Port 0 lets Chrome pick a free port, so two debug profiles never collide. Chrome binds it to 127.0.0.1.
// The extension flag lets Extensions.loadUnpacked load the tab groups extension over the launch pipe; it
// opens no port.
function launchArgsFor(mode: ProfileMode): string[] {
  const extensionLoading = "--enable-unsafe-extension-debugging";
  switch (mode) {
    case "stealth":
      return [extensionLoading];
    case "debug":
      return [extensionLoading, "--remote-debugging-port=0"];
  }
}

interface TabGroupsWorker {
  patchromeGroupTabs(request: { targetIds: string[]; title: string; color: TabGroupColor }): Promise<void>;
  patchromeDescribeTabGroups(request: { targetIds: string[] }): Promise<TabGroupSummary[]>;
}

interface ProxyRulesWorker {
  patchromeApplyProxyRules(rules: ProxyRulesForChrome | undefined): Promise<void>;
  patchromeRecentProxyFailures(request: { sinceMs: number }): Promise<ProxyFailure[]>;
  patchromeTimeZone(): Promise<string>;
}

// Patchright evaluates in an isolated world by default, where the extension's globals do not exist.
function evaluateInWorker<Arg, Result>(worker: Worker, fn: (arg: Arg) => Promise<Result>, arg: Arg): Promise<Result> {
  // oxlint-disable-next-line typescript/unbound-method -- called with worker as this on the next line
  const evaluate = worker.evaluate as unknown as (
    fn: (arg: Arg) => Promise<Result>,
    arg: Arg,
    isolatedContext: boolean,
  ) => Promise<Result>;
  return evaluate.call(worker, fn, arg, false);
}

// Chrome writes the chosen port and the browser target path to DevToolsActivePort once it listens.
async function readDevToolsEndpoint(chromeProfileDir: string): Promise<DebuggingEndpoint> {
  const deadlineMs = Date.now() + devToolsPortWaitMs;
  while (Date.now() < deadlineMs) {
    const content = await readFile(join(chromeProfileDir, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, browserPath] = content.split("\n");
    if (port && browserPath)
      return { httpUrl: `http://127.0.0.1:${port}`, browserWsUrl: `ws://127.0.0.1:${port}${browserPath}` };
    await sleep(100);
  }
  throw new Error(`Chrome wrote no DevToolsActivePort in ${chromeProfileDir} within ${devToolsPortWaitMs} ms`);
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function playwrightCookieOf(cookie: CdpCookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? "Lax",
  };
}

// The same match context.cookies(urls) applies: host within the cookie domain, path prefix, https for secure.
function cookieAppliesTo(cookie: Cookie, url: string): boolean {
  const parsed = new URL(url);
  const domain = cookie.domain.replace(/^\./, "");
  const isHostMatch =
    parsed.hostname === domain || (cookie.domain.startsWith(".") && parsed.hostname.endsWith(`.${domain}`));
  const path = parsed.pathname || "/";
  const isPathMatch =
    path === cookie.path ||
    path.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`) ||
    cookie.path === "/";
  return (
    isHostMatch &&
    isPathMatch &&
    (!cookie.secure ||
      parsed.protocol === "https:" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost")
  );
}
