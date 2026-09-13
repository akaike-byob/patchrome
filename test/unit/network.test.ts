import { describe, expect, it } from "vitest";
import { parseStorageState } from "../../src/commands.ts";
import { parseExtractSchema } from "../../src/extract.ts";
import { parseStatusFilter, urlGlobMatches } from "../../src/glob.ts";
import { buildHar, harTimings } from "../../src/har.ts";
import type { NetworkEntry } from "../../src/network.ts";
import { CommandError } from "../../src/protocol.ts";

function errorOf(action: () => unknown): CommandError | undefined {
  try {
    action();
  } catch (err) {
    if (err instanceof CommandError) return err;
    throw err;
  }
  return undefined;
}

describe("urlGlobMatches", () => {
  it("matches the whole URL with * and ?", () => {
    expect(urlGlobMatches("*/api/items", "https://shop.test/api/items")).toBe(true);
    expect(urlGlobMatches("*/api/items", "https://shop.test/api/items?page=2")).toBe(false);
    expect(urlGlobMatches("*api*", "https://shop.test/v1/api/x")).toBe(true);
    expect(urlGlobMatches("https://a.test/p?", "https://a.test/p1")).toBe(true);
    expect(urlGlobMatches("https://a.test/(x)+", "https://a.test/(x)+")).toBe(true);
  });
});

describe("parseStatusFilter", () => {
  it("accepts exact codes and classes", () => {
    const matches = parseStatusFilter("4xx,304");
    expect([404, 499, 304, 200, undefined].map(matches)).toEqual([true, true, true, false, false]);
  });

  it("rejects anything else", () => {
    expect(errorOf(() => parseStatusFilter("404s"))?.code).toBe("bad_args");
    expect(errorOf(() => parseStatusFilter("6xx"))?.code).toBe("bad_args");
  });
});

describe("parseExtractSchema", () => {
  it("normalises string and object fields", () => {
    expect(parseExtractSchema('{"rows": "li", "fields": {"a": "h2", "b": {"attr": "href", "all": true}}, "limit": 5}')).toEqual({
      rows: "li",
      limit: 5,
      fields: { a: { selector: "h2", attr: undefined, all: false }, b: { selector: undefined, attr: "href", all: true } },
    });
  });

  it("names the typo", () => {
    expect(errorOf(() => parseExtractSchema('{"row": "li", "fields": {"a": "h2"}}'))?.message).toContain("unknown keys row");
    expect(errorOf(() => parseExtractSchema('{"fields": {"a": {"selecter": "h2"}}}'))?.message).toBe("extract schema: fields.a has unknown keys selecter");
    expect(errorOf(() => parseExtractSchema('{"fields": {}}'))?.code).toBe("bad_args");
    expect(errorOf(() => parseExtractSchema("li.item"))?.code).toBe("bad_args");
  });
});

describe("parseStorageState", () => {
  it("accepts Playwright's storageState shape", () => {
    const state = parseStorageState(JSON.stringify({
      cookies: [{ name: "sid", value: "1", domain: "a.test", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [{ origin: "https://a.test", localStorage: [{ name: "k", value: "v" }] }],
    }));
    expect(state.cookies).toHaveLength(1);
  });

  it("rejects origins that are not bare http origins", () => {
    expect(errorOf(() => parseStorageState('{"cookies": [], "origins": [{"origin": "https://a.test/path", "localStorage": []}]}'))?.code).toBe("bad_args");
    expect(errorOf(() => parseStorageState('{"cookies": [{"name": "x"}], "origins": []}'))?.message).toBe("state file: cookies.0.value Invalid input: expected string, received undefined");
  });
});

describe("buildHar", () => {
  const entry = (overrides: Partial<NetworkEntry>): NetworkEntry => ({
    id: "n1",
    tabId: "t1",
    session: "s",
    method: "POST",
    url: "https://a.test/api?q=1",
    resourceType: "fetch",
    startedAtMs: Date.UTC(2026, 8, 13, 9, 0, 0),
    requestHeaders: { "content-type": "application/json" },
    postData: '{"x":1}',
    state: "finished",
    status: 200,
    statusText: "OK",
    responseHeaders: { "content-type": "application/json" },
    durationMs: 50,
    timing: { startTime: 0, domainLookupStart: 1, domainLookupEnd: 3, connectStart: 3, secureConnectionStart: 5, connectEnd: 9, requestStart: 10, responseStart: 30, responseEnd: 42 },
    failure: undefined,
    ...overrides,
  });

  it("builds entries with query, post data, body and timings, skipping pending requests", () => {
    const har = buildHar([entry({}), entry({ id: "n2", state: "pending" })], new Map([["n1", { text: '{"ok":true}', encoding: undefined }]]), "0.1.0");
    expect(har.log.entries).toHaveLength(1);
    const [first] = har.log.entries;
    expect(first?.request.queryString).toEqual([{ name: "q", value: "1" }]);
    expect(first?.request.postData).toEqual({ mimeType: "application/json", text: '{"x":1}' });
    expect(first?.response.content).toEqual({ size: 11, mimeType: "application/json", text: '{"ok":true}' });
    expect(first?.timings).toEqual({ blocked: -1, dns: 2, connect: 6, ssl: 4, send: 0, wait: 20, receive: 12 });
    expect(first?.time).toBe(40);
    expect(har.log.pages).toEqual([{ startedDateTime: "2026-09-13T09:00:00.000Z", id: "t1", title: "t1", pageTimings: {} }]);
  });

  it("gives reused connections -1 for dns and connect", () => {
    expect(harTimings({ startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: 0, responseStart: 8, responseEnd: 9 }).phases)
      .toMatchObject({ dns: -1, connect: -1, ssl: -1, wait: 8, receive: 1 });
  });
});
