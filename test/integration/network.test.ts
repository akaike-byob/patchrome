import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startDaemonAnsweringCopies, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

interface RequestSummary {
  id: string;
  url: string;
  status: number | undefined;
  type: string;
}

async function waitForTitle(home: string, session: string, title: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const evaluated = await runCli(home, session, ["eval", "document.title"]);
    if (evaluated.json.data?.value === title) return;
  }
  throw new Error(`title never became ${title}`);
}

describe("network, routes, extract and state", () => {
  let fixture: FixtureServer;
  const home = makeHome("network");

  beforeAll(async () => {
    fixture = await startFixtureServer();
    await startDaemonAnsweringCopies(home, "approved");
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("lists a session's requests with filters and returns a response body", async () => {
    await runCli(home, "net", ["open", `${fixture.origin}/shop`]);
    await waitForTitle(home, "net", "shop loaded");
    await runCli(home, "other", ["open", `${fixture.origin}/form?name=other`]);

    const fetches = await runCli(home, "net", ["network", "list", "--type", "fetch"]);
    const requests = fetches.json.data?.requests as RequestSummary[];
    expect(requests.map((request) => new URL(request.url).pathname).toSorted()).toEqual(["/api/items", "/api/missing"]);

    const notFound = await runCli(home, "net", ["network", "list", "--status", "4xx"]);
    expect((notFound.json.data?.requests as RequestSummary[]).map((request) => request.url)).toEqual([`${fixture.origin}/api/missing`]);

    const byUrl = await runCli(home, "net", ["network", "list", "--url", "*/api/items"]);
    const itemsId = (byUrl.json.data?.requests as RequestSummary[])[0]?.id;
    const body = await runCli(home, "net", ["network", "get", String(itemsId), "--body"]);
    expect(JSON.parse(String(body.json.data?.body))).toMatchObject({ items: [{ sku: "a1" }, { sku: "b2" }] });

    const plain = await runCli(home, "net", ["network", "get", String(itemsId)], {}, false);
    expect(plain.stdout).toMatch(/^> accept: /m);
    expect(plain.stdout).toMatch(/^< content-type: application\/json/m);

    const otherSession = await runCli(home, "other", ["network", "list", "--url", "*/api/*"]);
    expect(otherSession.json.data?.count).toBe(0);
    const stolen = await runCli(home, "other", ["network", "get", String(itemsId)]);
    expect(stolen.json.error?.code).toBe("bad_args");

    const badType = await runCli(home, "net", ["network", "list", "--type", "ajax"]);
    expect(badType.exitCode).toBe(2);
  });

  it("writes a HAR with text bodies for the requests made while recording", async () => {
    await runCli(home, "har", ["open"]);
    expect((await runCli(home, "har", ["network", "har", "start"])).json).toMatchObject({ ok: true });
    await runCli(home, "har", ["goto", `${fixture.origin}/shop`]);
    await waitForTitle(home, "har", "shop loaded");
    const stopped = await runCli(home, "har", ["network", "har", "stop"]);
    const har = JSON.parse(readFileSync(String(stopped.json.data?.path), "utf8")) as { log: { entries: Array<{ request: { url: string }; response: { status: number; content: { text?: string } } }> } };
    const items = har.log.entries.find((entry) => entry.request.url.endsWith("/api/items"));
    expect(items?.response.status).toBe(200);
    expect(items?.response.content.text).toContain("b2");
    expect(har.log.entries.some((entry) => entry.request.url.endsWith("/shop"))).toBe(true);
  });

  it("blocks and mocks requests for the session's tabs only", async () => {
    const mockFile = join(home, "items.json");
    writeFileSync(mockFile, JSON.stringify({ items: [{ sku: "mocked", price: 1 }] }));
    await runCli(home, "routed", ["route", "mock", "*/api/items", mockFile]);
    await runCli(home, "routed", ["open", `${fixture.origin}/shop`]);
    await waitForTitle(home, "routed", "shop loaded");
    expect((await runCli(home, "routed", ["text"])).json.data?.text).toContain("mocked");

    await runCli(home, "plain", ["open", `${fixture.origin}/shop`]);
    await waitForTitle(home, "plain", "shop loaded");
    expect((await runCli(home, "plain", ["text"])).json.data?.text).not.toContain("mocked");

    await runCli(home, "routed", ["route", "block", "*/api/items"]);
    expect((await runCli(home, "routed", ["route", "list"])).json.data?.rules).toHaveLength(2);
    await runCli(home, "routed", ["goto", `${fixture.origin}/shop`]);
    await waitForTitle(home, "routed", "shop failed");

    expect((await runCli(home, "routed", ["route", "clear"])).json.data?.cleared).toBe(2);
    await runCli(home, "routed", ["goto", `${fixture.origin}/shop`]);
    await waitForTitle(home, "routed", "shop loaded");
    expect((await runCli(home, "routed", ["text"])).json.data?.text).toContain("b2");
  });

  it("extracts rows from a schema file or inline JSON", async () => {
    await runCli(home, "scrape", ["open", `${fixture.origin}/shop`]);
    await waitForTitle(home, "scrape", "shop loaded");
    const schemaFile = join(home, "schema.json");
    writeFileSync(schemaFile, JSON.stringify({ rows: "li.item", fields: { sku: "h2", price: ".price", link: { selector: "a", attr: "href" }, missing: ".nope" } }));
    const fromFile = await runCli(home, "scrape", ["extract", schemaFile]);
    expect(fromFile.json.data?.rows).toEqual([
      { sku: "a1", price: "10", link: `${fixture.origin}/form?name=a1`, missing: null },
      { sku: "b2", price: "25", link: `${fixture.origin}/form?name=b2`, missing: null },
    ]);

    const inline = await runCli(home, "scrape", ["extract", '{"fields": {"skus": {"selector": "h2", "all": true}}}']);
    expect(inline.json.data?.rows).toEqual([{ skus: ["a1", "b2"] }]);

    const typo = await runCli(home, "scrape", ["extract", '{"row": "li", "fields": {"a": "h2"}}']);
    expect(typo.json.error?.message).toContain("unknown keys row");
  });

  it("signs in through login --until, then saves and reloads cookies and localStorage", async () => {
    const login = await runCli(home, "auth", ["login", `${fixture.origin}/login`, "--until", "*/form?name=home", "--timeout-ms", "20000"]);
    expect(login.json).toMatchObject({ ok: true, data: { outcome: "reached", cookieCount: 1 } });

    const cookies = await runCli(home, "auth", ["cookies", "--domain", "127.0.0.1"]);
    expect((cookies.json.data?.cookies as Array<{ name: string }>).map((cookie) => cookie.name)).toContain("sid");

    const stateFile = join(home, "state.json");
    const saved = await runCli(home, "auth", ["state", "save", stateFile]);
    expect(saved.json.data).toMatchObject({ cookies: 1, origins: [fixture.origin] });
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { origins: Array<{ localStorage: Array<{ name: string; value: string }> }> };
    expect(state.origins[0]?.localStorage).toContainEqual({ name: "token", value: "t-123" });

    await runCli(home, "auth", ["eval", "localStorage.clear()"]);
    const loaded = await runCli(home, "auth", ["state", "load", stateFile]);
    expect(loaded.json).toMatchObject({ ok: true, data: { cookies: 1 } });
    expect((await runCli(home, "auth", ["eval", "localStorage.getItem('token')"])).json.data?.value).toBe("t-123");

    const timedOut = await runCli(home, "auth", ["login", `${fixture.origin}/form?name=wait`, "--until", "*/never", "--timeout-ms", "1500"]);
    expect(timedOut.json.error?.code).toBe("timeout");
  });
});
