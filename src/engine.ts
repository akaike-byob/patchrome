import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type BrowserContext, type CDPSession, type Cookie, type Page, type Worker } from "patchright";
import { keepFocusDuring } from "./focus.ts";
import { readOriginStorageInPage, type OriginStorage } from "./origin-storage.ts";
import type { ProfileMode } from "./profile-mode.ts";
import type { TabGroupColor, TabGroupSummary } from "./tab-groups.ts";

export interface DebuggingEndpoint {
  httpUrl: string;
  browserWsUrl: string;
}

// The daemon talks to the browser only through this interface, so a different Playwright-compatible
// stealth engine can replace Patchright without touching sessions or commands.
export interface BrowserEngine {
  launch(chromeProfileDir: string, mode: ProfileMode): Promise<void>;
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

const pageOpenTimeoutMs = 15_000;
// Chrome activates 400-800ms into launch, before launch resolves. A longer grace sends the user's own
// Dock clicks on Chrome back to the previous app.
const focusGraceMs = 500;
const devToolsPortWaitMs = 10_000;
const extensionWorkerWaitMs = 10_000;
// src/ and dist/ both sit one level below the package root, next to extension/.
const tabGroupsExtensionDir = fileURLToPath(new URL("../extension/tab-groups", import.meta.url));

export class PatchrightEngine implements BrowserEngine {
  #context: BrowserContext | undefined;
  #browserCdp: CDPSession | undefined;
  #closedListeners: Array<() => void> = [];
  #endpoint: DebuggingEndpoint | undefined;
  #tabGroupsExtensionId: string | undefined;
  #targetIdByPage = new WeakMap<Page, Promise<string>>();

  async launch(chromeProfileDir: string, mode: ProfileMode): Promise<void> {
    // A port file left by an earlier Chrome would point at a dead port.
    await rm(join(chromeProfileDir, "DevToolsActivePort"), { force: true });
    const context = await keepFocusDuring(
      chromium.launchPersistentContext(chromeProfileDir, {
        channel: "chrome",
        headless: false,
        viewport: null,
        // Without this Playwright passes --no-sandbox, which weakens Chrome and shows a warning bar.
        chromiumSandbox: true,
        args: launchArgsFor(mode),
      }),
      focusGraceMs,
    );
    context.on("close", () => {
      for (const listener of this.#closedListeners) listener();
    });
    const browser = context.browser();
    if (!browser) throw new Error("persistent context exposed no browser for a browser-level CDP session");
    this.#browserCdp = await browser.newBrowserCDPSession();
    this.#context = context;
    const { id } = await this.#browserCdp.send("Extensions.loadUnpacked", { path: tabGroupsExtensionDir });
    this.#tabGroupsExtensionId = id;
    switch (mode) {
      case "stealth":
        break;
      case "debug":
        this.#endpoint = await readDevToolsEndpoint(chromeProfileDir);
        break;
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
    const worker = await this.#tabGroupsWorker();
    await evaluateInWorker(
      worker,
      (request) => (globalThis as unknown as TabGroupsWorker).patchromeGroupTabs(request),
      { targetIds, title, color },
    );
  }

  async describeTabGroups(pages: Page[]): Promise<TabGroupSummary[]> {
    const targetIds = await Promise.all(pages.map((page) => this.#targetIdOf(page)));
    const worker = await this.#tabGroupsWorker();
    return evaluateInWorker(
      worker,
      (request) => (globalThis as unknown as TabGroupsWorker).patchromeDescribeTabGroups(request),
      { targetIds },
    );
  }

  async readProfileCopy(
    copyUserDataDir: string,
    origins: string[],
  ): Promise<{ cookies: Cookie[]; origins: OriginStorage[] }> {
    const reader = await chromium.launchPersistentContext(copyUserDataDir, {
      channel: "chrome",
      headless: true,
      // The everyday profile encrypts cookies with the OS keychain key. Under Playwright's mock keychain Chrome
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

  async #tabGroupsWorker(): Promise<Worker> {
    const context = this.#requireContext();
    const prefix = `chrome-extension://${this.#tabGroupsExtensionId}/`;
    const isTabGroupsWorker = (worker: Worker) => worker.url().startsWith(prefix);
    return (
      context.serviceWorkers().find(isTabGroupsWorker) ??
      context.waitForEvent("serviceworker", { predicate: isTabGroupsWorker, timeout: extensionWorkerWaitMs })
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
