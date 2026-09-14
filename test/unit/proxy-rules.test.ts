import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { auditLine } from "../../src/copy-guard.ts";
import { isSameTimeZone, parseExitAddress } from "../../src/proxy-check.ts";
import {
  parseProxyName,
  parseProxyServer,
  parseRulePattern,
  proxyRulesForChrome,
  proxySummary,
  routeLabel,
  routeOf,
  ruleForHost,
  rulesInMatchOrder,
  type ProxyConfig,
} from "../../src/proxy-rules.ts";
import { readStoredProxies, writeStoredProxies } from "../../src/proxy-store.ts";

const config: ProxyConfig = {
  proxies: [
    { name: "de", server: "https://gw.example.net:8000", username: "alice" },
    { name: "corp", server: "https://proxy.corp:443" },
  ],
  rules: [
    { pattern: "*", via: "corp" },
    { pattern: "*.example.de", via: "de" },
    { pattern: "example.de", via: "de" },
    { pattern: "shop.example.de", via: "direct" },
    { pattern: "ads.example.de", via: "block" },
    { pattern: "*.cdn.example.de", via: "direct" },
  ],
};

describe("proxy names, servers and patterns", () => {
  it("takes only https proxy servers, normalized to https://host:port", () => {
    expect(parseProxyServer("https://gw.example.net")).toBe("https://gw.example.net:443");
    expect(parseProxyServer("https://GW.example.net:8000/")).toBe("https://gw.example.net:8000");
    expect(() => parseProxyServer("http://gw.example.net:8000")).toThrow("patchrome takes only https proxies");
    expect(() => parseProxyServer("socks5://gw.example.net:1080")).toThrow("patchrome takes only https proxies");
    expect(() => parseProxyServer("https://alice:secret@gw.example.net")).toThrow("must not contain credentials");
    expect(() => parseProxyServer("https://gw.example.net/path")).toThrow("has a path");
    expect(() => parseProxyServer("gw.example.net:8000")).toThrow("is not a URL");
  });

  it("keeps direct and block for routes", () => {
    expect(parseProxyName("de-1")).toBe("de-1");
    expect(() => parseProxyName("direct")).toThrow("built-in route");
    expect(() => parseProxyName("block")).toThrow("built-in route");
    expect(() => parseProxyName("../x")).toThrow("invalid proxy name");
  });

  it("takes a host, its subdomains or every host, and nothing with a scheme, port or path", () => {
    expect(parseRulePattern("Example.DE.")).toBe("example.de");
    expect(parseRulePattern("*.example.de")).toBe("*.example.de");
    expect(parseRulePattern("*")).toBe("*");
    expect(parseRulePattern("10.0.0.5")).toBe("10.0.0.5");
    expect(parseRulePattern("b\u00fccher.de")).toBe("xn--bcher-kva.de");
    for (const bad of [
      "https://example.de",
      "example.de:443",
      "example.de/path",
      "ex*ample.de",
      "*example.de",
      "",
      "*.*",
    ])
      expect(() => parseRulePattern(bad), bad).toThrow("invalid rule pattern");
  });
});

describe("rule matching", () => {
  it("picks the exact host, then the longest subdomain pattern, then *", () => {
    const via = (host: string) => ruleForHost(config.rules, host)?.pattern;
    expect(via("example.de")).toBe("example.de");
    expect(via("shop.example.de")).toBe("shop.example.de");
    expect(via("img.cdn.example.de")).toBe("*.cdn.example.de");
    expect(via("cdn.example.de")).toBe("*.example.de");
    expect(via("www.example.de")).toBe("*.example.de");
    expect(via("notexample.de")).toBe("*");
    expect(via("WWW.Example.DE.")).toBe("*.example.de");
    expect(ruleForHost([], "example.de")).toBeUndefined();
  });

  it("lists rules in the order it checks them", () => {
    expect(rulesInMatchOrder(config.rules).map((rule) => rule.pattern)).toEqual([
      "shop.example.de",
      "ads.example.de",
      "example.de",
      "*.cdn.example.de",
      "*.example.de",
      "*",
    ]);
  });

  it("names the route a rule gives", () => {
    expect(routeLabel(routeOf(config, ruleForHost(config.rules, "www.example.de")))).toBe(
      "via de (gw.example.net:8000)",
    );
    expect(routeLabel(routeOf(config, ruleForHost(config.rules, "ads.example.de")))).toBe("blocked");
    expect(routeLabel(routeOf(config, undefined))).toBe("direct");
    expect(proxySummary(config)).toBe("proxy: 6 rules, unmatched hosts corp");
    expect(proxySummary({ proxies: [], rules: [] })).toBe("proxy: off");
  });
});

describe("the PAC script Chrome runs", () => {
  const forChrome = proxyRulesForChrome(config, { de: "secret" });
  const findProxy = (host: string) =>
    runInNewContext(`${forChrome?.pacScript}\nFindProxyForURL("https://" + host + "/", host)`, { host }) as string;

  it("routes every host the way ruleForHost does", () => {
    const expected: Record<string, string> = {
      "example.de": "HTTPS gw.example.net:8000",
      "www.example.de": "HTTPS gw.example.net:8000",
      "shop.example.de": "DIRECT",
      "ads.example.de": "HTTPS 127.0.0.1:1",
      "img.cdn.example.de": "DIRECT",
      "cdn.example.de": "HTTPS gw.example.net:8000",
      "notexample.de": "HTTPS proxy.corp:443",
      "WWW.EXAMPLE.DE.": "HTTPS gw.example.net:8000",
    };
    for (const [host, result] of Object.entries(expected)) expect(findProxy(host), host).toBe(result);
  });

  it("sends unmatched hosts direct without a * rule, and turns off with no rules", () => {
    const noCatchAll = proxyRulesForChrome(
      { ...config, rules: config.rules.filter((rule) => rule.pattern !== "*") },
      {},
    );
    expect(runInNewContext(`${noCatchAll?.pacScript}\nFindProxyForURL("https://a.test/", "a.test")`)).toBe("DIRECT");
    expect(proxyRulesForChrome({ ...config, rules: [] }, {})).toBeUndefined();
  });

  it("never resolves DNS", () => {
    expect(forChrome?.pacScript).not.toMatch(/dnsResolve|isInNet|isResolvable/);
  });

  it("gives Chrome credentials by the host and port it names the proxy with", () => {
    expect(forChrome?.credentials).toEqual([
      { challenger: "gw.example.net:8000", username: "alice", password: "secret" },
    ]);
  });
});

describe("stored proxies", () => {
  const pathsIn = (dir: string) => ({
    configPath: join(dir, "proxies.json"),
    secretsPath: join(dir, "proxy-secrets.json"),
  });

  it("writes passwords to a file only the user can read, apart from the rules", async () => {
    const paths = pathsIn(mkdtempSync(join(tmpdir(), "patchrome-proxies-")));
    await writeStoredProxies(paths, { config, passwords: { de: "secret" } });
    expect(readFileSync(paths.configPath, "utf8")).not.toContain("secret");
    expect(statSync(paths.secretsPath).mode & 0o777).toBe(0o600);
    expect(await readStoredProxies(paths)).toEqual({ config, passwords: { de: "secret" } });
  });

  it("reads missing files as no proxies", async () => {
    expect(await readStoredProxies(pathsIn(mkdtempSync(join(tmpdir(), "patchrome-proxies-"))))).toEqual({
      config: { proxies: [], rules: [] },
      passwords: {},
    });
  });

  it("rejects hand edits the CLI would have refused, naming the file", async () => {
    const edits: Array<[unknown, Record<string, string>, string]> = [
      [{ proxies: [{ name: "p", server: "http://gw:80" }], rules: [] }, {}, "patchrome takes only https proxies"],
      [{ proxies: [], rules: [{ pattern: "a.test", via: "gone" }] }, {}, "routes via gone, which is not a proxy"],
      [
        { proxies: [{ name: "p", server: "https://gw:443", username: "u" }], rules: [] },
        {},
        "has a username but no password",
      ],
      [{ proxies: [], rules: [] }, { ghost: "x" }, "proxy ghost, which does not exist"],
      [
        {
          proxies: [
            { name: "a", server: "https://gw:443" },
            { name: "b", server: "https://gw:443" },
          ],
          rules: [],
        },
        {},
        "use the same server",
      ],
      [{ proxies: [], rules: [], extra: true }, {}, "unknown keys extra"],
    ];
    for (const [edited, passwords, message] of edits) {
      const paths = pathsIn(mkdtempSync(join(tmpdir(), "patchrome-proxies-")));
      writeFileSync(paths.configPath, JSON.stringify(edited));
      writeFileSync(paths.secretsPath, JSON.stringify(passwords));
      await expect(readStoredProxies(paths), message).rejects.toThrow(message);
    }
  });
});

describe("exit address and audit lines", () => {
  it("reads the common IP echo shapes", () => {
    expect(parseExitAddress('{"ip":"203.0.113.7","country":"DE","timezone":"Europe/Berlin"}')).toEqual({
      ip: "203.0.113.7",
      country: "DE",
      timeZone: "Europe/Berlin",
    });
    expect(parseExitAddress('{"query":"203.0.113.8","countryCode":"US"}')).toEqual({
      ip: "203.0.113.8",
      country: "US",
      timeZone: undefined,
    });
    expect(parseExitAddress("203.0.113.9\n")).toEqual({ ip: "203.0.113.9", country: undefined, timeZone: undefined });
  });

  it("treats two names for one timezone as the same zone", () => {
    // Windows Chrome reports Asia/Calcutta where ipinfo.io reports Asia/Kolkata.
    expect(isSameTimeZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
    expect(isSameTimeZone("US/Eastern", "America/New_York")).toBe(true);
    expect(isSameTimeZone("Asia/Kolkata", "Asia/Singapore")).toBe(false);
    expect(isSameTimeZone("Not/AZone", "Not/AZone")).toBe(true);
    expect(isSameTimeZone("Not/AZone", "Europe/Berlin")).toBe(false);
  });

  it("prints a proxy change beside login copies", () => {
    expect(
      auditLine({
        atUtc: "2026-09-14T10:00:00.000Z",
        profile: "stealth",
        kind: "proxy-rule-add",
        session: "s1",
        change: "add rule *.example.de via de",
      }),
    ).toBe("2026-09-14T10:00:00.000Z proxy s1: add rule *.example.de via de");
  });
});
