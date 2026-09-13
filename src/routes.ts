import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Page, Route } from "patchright";
import { urlGlobMatches } from "./glob.ts";
import { CommandError } from "./protocol.ts";
import type { Tab } from "./sessions.ts";

export type RouteRule =
  | { kind: "block"; glob: string }
  | { kind: "mock"; glob: string; file: string; body: Buffer; contentType: string };

const contentTypes: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

type UrlMatcher = (url: URL) => boolean;

// Rules belong to a session and apply to every tab it owns, including popups opened later. A tab only
// intercepts requests while its session has rules, since interception turns off Chrome's cache.
export class RouteTable {
  #rules = new Map<string, RouteRule[]>();
  #installed = new Map<Page, UrlMatcher>();
  #tabsBySession = new Map<string, Set<Tab>>();

  track(tab: Tab): void {
    let tabs = this.#tabsBySession.get(tab.session);
    if (!tabs) {
      tabs = new Set();
      this.#tabsBySession.set(tab.session, tabs);
    }
    tabs.add(tab);
    tab.page.on("close", () => {
      tabs.delete(tab);
      this.#installed.delete(tab.page);
    });
    if (this.rulesOf(tab.session).length > 0) void this.#install(tab);
  }

  async block(session: string, glob: string): Promise<RouteRule> {
    return this.#add(session, { kind: "block", glob });
  }

  async mock(session: string, glob: string, file: string): Promise<RouteRule> {
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch (err) {
      throw new CommandError(
        "bad_args",
        `cannot read mock file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.#add(session, {
      kind: "mock",
      glob,
      file,
      body,
      contentType: contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
  }

  rulesOf(session: string): RouteRule[] {
    return this.#rules.get(session) ?? [];
  }

  async clear(session: string): Promise<number> {
    const count = this.rulesOf(session).length;
    this.#rules.delete(session);
    await Promise.all(
      [...(this.#tabsBySession.get(session) ?? [])].map(async (tab) => {
        const matcher = this.#installed.get(tab.page);
        if (!matcher) return;
        this.#installed.delete(tab.page);
        await tab.page.unroute(matcher).catch(() => {});
      }),
    );
    return count;
  }

  async forget(session: string): Promise<void> {
    await this.clear(session);
    this.#tabsBySession.delete(session);
  }

  async #add(session: string, rule: RouteRule): Promise<RouteRule> {
    this.#rules.set(session, [...this.rulesOf(session), rule]);
    await Promise.all([...(this.#tabsBySession.get(session) ?? [])].map((tab) => this.#install(tab)));
    return rule;
  }

  async #install(tab: Tab): Promise<void> {
    if (this.#installed.has(tab.page)) return;
    const matcher: UrlMatcher = (url) => this.#ruleFor(tab.session, url.href) !== undefined;
    this.#installed.set(tab.page, matcher);
    await tab.page
      .route(matcher, (route) => this.#handle(tab.session, route))
      .catch(() => {
        this.#installed.delete(tab.page);
      });
  }

  // The newest matching rule wins, so an agent can narrow an earlier broad block with a mock.
  #ruleFor(session: string, url: string): RouteRule | undefined {
    return this.rulesOf(session).findLast((rule) => urlGlobMatches(rule.glob, url));
  }

  async #handle(session: string, route: Route): Promise<void> {
    const rule = this.#ruleFor(session, route.request().url());
    if (!rule) return route.fallback();
    switch (rule.kind) {
      case "block":
        return route.abort("blockedbyclient");
      case "mock":
        return route.fulfill({ status: 200, contentType: rule.contentType, body: rule.body });
    }
  }
}
