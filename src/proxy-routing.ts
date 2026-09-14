import { appendAuditEntry, type ProxyChangeKind } from "./copy-guard.ts";
import type { BrowserEngine } from "./engine.ts";
import { CommandError } from "./protocol.ts";
import {
  emptyProxyConfig,
  hostPortOf,
  proxyRulesForChrome,
  routeOf,
  ruleForHost,
  type ProxyConfig,
  type ProxyRoute,
  type ProxyRule,
} from "./proxy-rules.ts";
import {
  checkConsistent,
  readStoredProxies,
  writeStoredProxies,
  type ProxyStorePaths,
  type StoredProxies,
} from "./proxy-store.ts";

export interface ProxyRoutingOptions {
  paths: ProxyStorePaths;
  engine: BrowserEngine;
  auditLogPath: string;
  profile: string;
  log: (message: string) => void;
  nowMs?: () => number;
}

// Chrome's net errors that mean the proxy, not the site, stopped the request.
const proxyNetErrors = new Set([
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CERTIFICATE_INVALID",
  "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_PROXY_AUTH_REQUESTED",
  "ERR_NO_SUPPORTED_PROXIES",
]);

// The daemon's one copy of the profile's proxies and rules. Every change goes to disk, then to Chrome, then to
// the audit log, one change at a time; a step that fails puts the earlier steps back.
export class ProxyRouting {
  readonly #options: ProxyRoutingOptions;
  #stored: StoredProxies = { config: emptyProxyConfig, passwords: {} };
  #turns: Promise<unknown> = Promise.resolve();

  constructor(options: ProxyRoutingOptions) {
    this.#options = options;
  }

  async load(): Promise<void> {
    this.#stored = await readStoredProxies(this.#options.paths);
  }

  // Chrome keeps an extension's proxy setting in the profile, so a launch always applies the files' rules,
  // turning off rules the files no longer hold.
  async applyToChrome(): Promise<void> {
    await this.#options.engine.applyProxyRules(proxyRulesForChrome(this.#stored.config, this.#stored.passwords));
    if (this.#stored.config.rules.length > 0)
      this.#options.log(`applied ${this.#stored.config.rules.length} proxy rules`);
  }

  config(): ProxyConfig {
    return this.#stored.config;
  }

  hasRules(): boolean {
    return this.#stored.config.rules.length > 0;
  }

  hasPassword(proxyName: string): boolean {
    return this.#stored.passwords[proxyName] !== undefined;
  }

  password(proxyName: string): string | undefined {
    return this.#stored.passwords[proxyName];
  }

  routeFor(host: string): { rule: ProxyRule | undefined; route: ProxyRoute } {
    const rule = ruleForHost(this.#stored.config.rules, host);
    return { rule, route: routeOf(this.#stored.config, rule) };
  }

  async change(
    session: string,
    kind: ProxyChangeKind,
    describe: string,
    mutate: (stored: StoredProxies) => StoredProxies,
  ): Promise<StoredProxies> {
    const turn = this.#turns.then(() => this.#change(session, kind, describe, mutate));
    this.#turns = turn.catch(() => {});
    return turn;
  }

  async #change(
    session: string,
    kind: ProxyChangeKind,
    describe: string,
    mutate: (stored: StoredProxies) => StoredProxies,
  ): Promise<StoredProxies> {
    const before = this.#stored;
    const after = mutate(before);
    checkConsistent(after.config, after.passwords);
    const { paths, engine } = this.#options;
    try {
      await writeStoredProxies(paths, after);
      await engine.applyProxyRules(proxyRulesForChrome(after.config, after.passwords));
      // An unrecorded change is what the log exists to prevent, so a failed write undoes the change.
      await appendAuditEntry(this.#options.auditLogPath, {
        atUtc: new Date((this.#options.nowMs ?? Date.now)()).toISOString(),
        profile: this.#options.profile,
        kind,
        session,
        change: describe,
      });
    } catch (err) {
      await writeStoredProxies(paths, before).catch((undoErr: unknown) =>
        this.#options.log(`putting back the earlier proxy files failed: ${String(undoErr)}`),
      );
      await engine
        .applyProxyRules(proxyRulesForChrome(before.config, before.passwords))
        .catch((undoErr: unknown) =>
          this.#options.log(`putting back the earlier proxy rules failed: ${String(undoErr)}`),
        );
      throw err;
    }
    this.#stored = after;
    this.#options.log(`proxy change by ${session}: ${describe}`);
    return after;
  }

  // A failed navigation says why when a proxy rule decided the route. Undefined leaves the error as it was.
  async explainNavigationFailure(url: string, message: string, sinceMs: number): Promise<CommandError | undefined> {
    if (!this.hasRules()) return undefined;
    const netError = message.match(/net::(ERR_[A-Z_]+)/)?.[1];
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    if (netError === undefined) return undefined;
    const { rule, route } = this.routeFor(host);
    switch (route.kind) {
      case "direct":
        return undefined;
      case "block":
        return new CommandError(
          "navigation_failed",
          `${host} is blocked by proxy rule ${rule?.pattern ?? "*"}`,
          "`patchrome proxy rule list` shows the rules; ask the user before changing one, it applies to every session",
        );
      case "proxy": {
        const challenger = hostPortOf(route.proxy.server);
        const failures = await this.#options.engine.recentProxyFailures(sinceMs).catch(() => []);
        const authFailure = failures.find(
          (failure) =>
            (failure.kind === "auth_refused" || failure.kind === "no_credentials") && failure.challenger === challenger,
        );
        if (authFailure !== undefined)
          return new CommandError(
            "proxy_auth_failed",
            authFailure.kind === "no_credentials"
              ? `proxy ${route.proxy.name} (${challenger}) asked for a password and none is stored, loading ${host}`
              : `proxy ${route.proxy.name} (${challenger}) refused its credentials, loading ${host}`,
            "tell the user the proxy credentials need fixing; do not retry",
          );
        if (!proxyNetErrors.has(netError)) return undefined;
        return new CommandError(
          "proxy_unreachable",
          `proxy ${route.proxy.name} (${challenger}) failed loading ${host}: net::${netError}`,
          `\`patchrome proxy test ${url}\` checks the proxy; tell the user if it stays down`,
        );
      }
    }
  }
}
