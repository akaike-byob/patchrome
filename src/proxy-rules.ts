import { isIPv4 } from "node:net";
import { isValidName } from "./paths.ts";
import { CommandError } from "./protocol.ts";

// A rule sends the hosts that match its pattern to a named proxy, straight to the site, or nowhere.
// Chrome hands a PAC script only the scheme and host of an https URL, so rules match hosts, never paths.
export const builtInRoutes = ["direct", "block"] as const;
export type BuiltInRoute = (typeof builtInRoutes)[number];

export interface ProxyServer {
  name: string;
  // Always https://host:port: Chrome sends the password and every CONNECT host inside TLS to the proxy.
  server: string;
  username?: string;
}

export interface ProxyRule {
  pattern: string;
  // A proxy name, or one of builtInRoutes.
  via: string;
}

export interface ProxyConfig {
  proxies: ProxyServer[];
  rules: ProxyRule[];
}

export type ProxyRoute = { kind: "proxy"; proxy: ProxyServer } | { kind: BuiltInRoute };

export interface ProxyCredential {
  // host:port as Chrome names the proxy in webRequest.onAuthRequired's challenger.
  challenger: string;
  username: string;
  password: string;
}

// What the extension applies: undefined turns rules off and gives Chrome back its own proxy settings.
export interface ProxyRulesForChrome {
  pacScript: string;
  credentials: ProxyCredential[];
}

export const emptyProxyConfig: ProxyConfig = { proxies: [], rules: [] };

// Nothing listens on port 1 of the loopback, and a proxy that refuses the connection fails the request
// without Chrome trying the site directly.
const blockedProxy = "HTTPS 127.0.0.1:1";

export function isBuiltInRoute(value: string): value is BuiltInRoute {
  return (builtInRoutes as readonly string[]).includes(value);
}

export function parseProxyName(raw: string): string {
  if (isBuiltInRoute(raw))
    throw new CommandError("bad_args", `${raw} is a built-in route, not a proxy name`, "pick another name");
  if (!isValidName(raw))
    throw new CommandError("bad_args", `invalid proxy name ${raw}`, "use letters, digits, dot, dash, underscore");
  return raw;
}

export function parseProxyServer(raw: string): string {
  let url: URL;
  try {
    // Without a scheme, URL reads `host:port` as a scheme named after the host.
    if (!raw.includes("://")) throw new Error("no scheme");
    url = new URL(raw);
  } catch {
    throw new CommandError("bad_args", `proxy server ${raw} is not a URL`, "give it as https://host:port");
  }
  if (url.protocol !== "https:")
    throw new CommandError(
      "bad_args",
      `proxy server ${raw} uses ${url.protocol.replace(/:$/, "")}; patchrome takes only https proxies`,
      "an https proxy keeps the password and the sites you visit encrypted on the way to it; ask the provider for its https endpoint",
    );
  if (url.username !== "" || url.password !== "")
    throw new CommandError(
      "bad_args",
      "proxy URL must not contain credentials",
      "use --username with --password-stdin or --password-env",
    );
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "")
    throw new CommandError("bad_args", `proxy server ${raw} has a path`, "give it as https://host:port");
  return `https://${url.hostname}:${url.port === "" ? "443" : url.port}`;
}

// `example.de` is that host, `*.example.de` its subdomains only, `*` every host.
export function parseRulePattern(raw: string): string {
  const lowered = raw.trim().toLowerCase().replace(/\.$/, "");
  if (lowered === "*") return lowered;
  const isSubdomains = lowered.startsWith("*.");
  const host = isSubdomains ? lowered.slice(2) : lowered;
  const normalized = hostnameOf(host);
  if (normalized === undefined)
    throw new CommandError(
      "bad_args",
      `invalid rule pattern ${raw}`,
      "use a host (example.de), its subdomains (*.example.de) or * for every host; no scheme, port or path",
    );
  return isSubdomains ? `*.${normalized}` : normalized;
}

// Chrome gives PAC the punycode form of a Unicode domain, so a rule stores that form.
function hostnameOf(host: string): string | undefined {
  if (host === "" || host.includes("*") || host.includes(":") || host.includes("/")) return undefined;
  if (!isIPv4(host) && !/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$/u.test(host)) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

// The rule that decides a host: the exact host first, then the longest matching subdomain pattern, then `*`.
export function ruleForHost(rules: ProxyRule[], host: string): ProxyRule | undefined {
  const lowered = host.toLowerCase().replace(/\.$/, "");
  return rulesInMatchOrder(rules).find((rule) => patternMatches(rule.pattern, lowered));
}

export function patternMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

// The order `proxy rule list` prints and ruleForHost checks.
export function rulesInMatchOrder(rules: ProxyRule[]): ProxyRule[] {
  const rank = (pattern: string) => (pattern === "*" ? 2 : pattern.startsWith("*.") ? 1 : 0);
  return rules.toSorted(
    (a, b) =>
      rank(a.pattern) - rank(b.pattern) || b.pattern.length - a.pattern.length || a.pattern.localeCompare(b.pattern),
  );
}

export function routeOf(config: ProxyConfig, rule: ProxyRule | undefined): ProxyRoute {
  if (rule === undefined) return { kind: "direct" };
  if (isBuiltInRoute(rule.via)) return { kind: rule.via };
  const proxy = config.proxies.find((candidate) => candidate.name === rule.via);
  if (proxy === undefined) throw new Error(`rule ${rule.pattern} names proxy ${rule.via}, which does not exist`);
  return { kind: "proxy", proxy };
}

// URL.host drops a default port, and Chrome names a proxy with its port even when it is 443.
export function hostPortOf(server: string): string {
  const url = new URL(server);
  return `${url.hostname}:${url.port === "" ? "443" : url.port}`;
}

// Chrome runs this for every request. Unmatched hosts go direct; rules never resolve DNS, which would leak
// lookups for proxied sites to the local resolver.
export function pacScriptFor(config: ProxyConfig): string {
  const exact: Record<string, string> = {};
  const subdomains: Array<[string, string]> = [];
  let fallback = "DIRECT";
  for (const rule of rulesInMatchOrder(config.rules)) {
    const route = routeOf(config, rule);
    const result =
      route.kind === "proxy"
        ? `HTTPS ${hostPortOf(route.proxy.server)}`
        : route.kind === "block"
          ? blockedProxy
          : "DIRECT";
    if (rule.pattern === "*") fallback = result;
    else if (rule.pattern.startsWith("*.")) subdomains.push([rule.pattern.slice(1), result]);
    else exact[rule.pattern] = result;
  }
  return `var exact = ${JSON.stringify(exact)};
var subdomains = ${JSON.stringify(subdomains)};
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (host.charAt(host.length - 1) === ".") host = host.substring(0, host.length - 1);
  if (Object.prototype.hasOwnProperty.call(exact, host)) return exact[host];
  for (var i = 0; i < subdomains.length; i++) {
    var suffix = subdomains[i][0];
    if (host.length > suffix.length && host.substring(host.length - suffix.length) === suffix) return subdomains[i][1];
  }
  return ${JSON.stringify(fallback)};
}`;
}

export function proxyRulesForChrome(
  config: ProxyConfig,
  passwords: Record<string, string>,
): ProxyRulesForChrome | undefined {
  if (config.rules.length === 0) return undefined;
  const credentials = config.proxies.flatMap((proxy) => {
    const password = passwords[proxy.name];
    return proxy.username === undefined || password === undefined
      ? []
      : [{ challenger: hostPortOf(proxy.server), username: proxy.username, password }];
  });
  return { pacScript: pacScriptFor(config), credentials };
}

export function routeLabel(route: ProxyRoute): string {
  switch (route.kind) {
    case "proxy":
      return `via ${route.proxy.name} (${hostPortOf(route.proxy.server)})`;
    case "direct":
      return "direct";
    case "block":
      return "blocked";
  }
}

// One line for `daemon status` and `sessions`, so an agent can tell its traffic is proxied without asking.
export function proxySummary(config: ProxyConfig): string {
  if (config.rules.length === 0) return "proxy: off";
  const catchAll = config.rules.find((rule) => rule.pattern === "*");
  return `proxy: ${config.rules.length} rule${config.rules.length === 1 ? "" : "s"}, unmatched hosts ${catchAll === undefined ? "direct" : catchAll.via}`;
}
