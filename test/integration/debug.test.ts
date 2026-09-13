import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, type FixtureServer } from "./helpers.ts";

const binPath = fileURLToPath(new URL("../../bin/patchrome.js", import.meta.url));

interface ConsoleSummary {
  level: string;
  text: string;
}

describe("debug profile", () => {
  let fixture: FixtureServer;
  const home = makeHome("debug");
  const debug = (session: string, args: string[]) => runCli(home, session, ["--profile", "debug", ...args]);
  const stealth = (session: string, args: string[]) => runCli(home, session, ["--profile", "stealth", ...args]);

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await debug("teardown", ["daemon", "stop"]);
    await stealth("teardown", ["daemon", "stop"]);
    await fixture.close();
  });

  it("captures console messages and page errors per session", async () => {
    await debug("dbg", ["open", `${fixture.origin}/noisy`]);
    await debug("quiet", ["open", `${fixture.origin}/form`]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const all = await debug("dbg", ["console"]);
    expect(all.exitCode).toBe(0);
    const messages = all.json.data?.messages as ConsoleSummary[];
    expect(messages.map((message) => `${message.level} ${message.text}`)).toEqual(["info hello 42", "warning careful", "error broken thing"]);

    const errorsOnly = await debug("dbg", ["console", "--level", "error"]);
    expect((errorsOnly.json.data?.messages as ConsoleSummary[]).map((message) => message.text)).toEqual(["broken thing"]);

    // The fixture throws from a 50 ms timer, and Chrome delays timers in background tabs by up to a second.
    let pageErrors: Array<{ message: string; stack: string }> = [];
    const deadlineMs = Date.now() + 5_000;
    while (pageErrors.length === 0 && Date.now() < deadlineMs) {
      pageErrors = ((await debug("dbg", ["errors"])).json.data?.errors ?? []) as typeof pageErrors;
      if (pageErrors.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(pageErrors).toHaveLength(1);
    expect(pageErrors[0]?.message).toBe("Error: boom from fixture");
    expect(pageErrors[0]?.stack).toContain("/noisy");

    expect((await debug("quiet", ["console"])).json.data?.count).toBe(0);
  });

  it("streams console messages with --follow while the session keeps working", async () => {
    await debug("follow", ["open", `${fixture.origin}/ticker`]);
    const lines = await new Promise<string[]>((resolve) => {
      execFile(process.execPath, [binPath, "--profile", "debug", "--session", "follow", "--timeout-ms", "1500", "console", "--follow"], {
        env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" },
      }, (_err, stdout) => resolve(stdout.trim().split("\n")));
    });
    const ticks = lines.filter((line) => / info tick \d+/.test(line));
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toMatch(/^followed for 1500 ms, \d+ messages$/);
  });

  it("does not block the session's other commands during a follow", async () => {
    await debug("parallel", ["open", `${fixture.origin}/ticker`]);
    const follow = runCli(home, "parallel", ["--profile", "debug", "--timeout-ms", "3000", "console", "--follow"]);
    const startedMs = Date.now();
    const evaluated = await debug("parallel", ["eval", "document.title"]);
    expect(evaluated.json.data?.value).toBe("ticker");
    expect(Date.now() - startedMs).toBeLessThan(2500);
    await follow;
  });

  it("streams console and page errors through watch, and reads CDP help from the running Chrome", async () => {
    await debug("watch-debug", ["open", `${fixture.origin}/form`]);
    const streamed = new Promise<string[]>((resolve) => {
      execFile(process.execPath, [binPath, "--profile", "debug", "--session", "watch-debug", "watch", "--events", "console,error", "--count", "4"], {
        env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" },
        timeout: 60_000,
      }, (_err, stdout) => resolve(stdout.trim().split("\n")));
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await debug("watch-debug", ["goto", `${fixture.origin}/noisy`]);
    const lines = await streamed;
    expect(lines.filter((line) => line.startsWith("console ")).map((line) => line.replace(/^console c\d+ t\d+ /, "").replace(/ \(.*\)$/, ""))).toEqual(["info hello 42", "warning careful", "error broken thing"]);
    expect(lines.find((line) => line.startsWith("error "))).toMatch(/^error x\d+ t\d+ Error: boom from fixture$/);
    expect(lines.at(-1)).toBe("watched 4 events, stopped on count");

    const navigate = await debug("watch-debug", ["cdp", "help", "Page.navigate"]);
    expect(navigate.json.data?.help).toContain("command Page.navigate");
    expect(navigate.json.data?.help).toContain("  url: string");
    const domains = await debug("watch-debug", ["cdp", "help"]);
    expect(readFileSync(String(domains.json.data?.path), "utf8")).toMatch(/^Runtime  \d+ commands, \d+ events$/m);
    expect((await stealth("watch-debug", ["cdp", "help"])).json.error?.code).toBe("unsupported_in_stealth");
  });

  it("records a trace owned by one session", async () => {
    await debug("tracer", ["open", `${fixture.origin}/form`]);
    expect((await debug("tracer", ["trace", "start"])).exitCode).toBe(0);
    const clash = await debug("other", ["trace", "start"]);
    expect(clash.json.error?.message).toContain("tracer is already tracing");
    await debug("tracer", ["goto", `${fixture.origin}/form?name=traced`]);
    const stopped = await debug("tracer", ["trace", "stop"]);
    const path = stopped.json.data?.path as string;
    expect(path).toMatch(/trace-1\.zip$/);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });

  it("sends raw CDP to the current tab", async () => {
    await debug("raw", ["open", `${fixture.origin}/form?name=cdp`]);
    const reply = await debug("raw", ["cdp", "Runtime.evaluate", '{"expression": "document.title", "returnByValue": true}']);
    expect(reply.json.data?.result).toMatchObject({ result: { value: "form cdp" } });
    const bad = await debug("raw", ["cdp", "Nope.nothing"]);
    expect(bad.json.error?.code).toBe("bad_args");
  });

  it("exposes a 127.0.0.1 debugging endpoint that answers", async () => {
    const endpoint = await debug("attach", ["devtools-url"]);
    const httpUrl = endpoint.json.data?.httpUrl as string;
    expect(httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const version = await (await fetch(`${httpUrl}/json/version`)).json() as { webSocketDebuggerUrl: string };
    expect(version.webSocketDebuggerUrl).toBe(endpoint.json.data?.browserWsUrl);
    const status = await debug("attach", ["daemon", "status"]);
    expect(status.json.data).toMatchObject({ mode: "debug", devtoolsUrl: httpUrl });
  });

  it("refuses debug commands in a stealth profile and opens no port", async () => {
    await stealth("sneaky", ["open", `${fixture.origin}/noisy`]);
    for (const args of [["console"], ["errors"], ["trace", "start"], ["cdp", "Performance.getMetrics"], ["devtools-url"]]) {
      const refused = await stealth("sneaky", args);
      expect(refused.json.error?.code, args.join(" ")).toBe("unsupported_in_stealth");
      expect(refused.exitCode).toBe(1);
    }
    expect(existsSync(join(home, "stealth", "chrome-profile", "DevToolsActivePort"))).toBe(false);
    const status = (await stealth("sneaky", ["daemon", "status"])).json.data;
    expect(status).toMatchObject({ mode: "stealth" });
    expect(status).not.toHaveProperty("devtoolsUrl");
  });

  it("keeps a profile's mode fixed", async () => {
    const created = await runCli(home, "x", ["profile", "create", "debug", "--mode", "debug"]);
    expect(created.json.data).toMatchObject({ mode: "debug", isNew: false });
    const changed = await runCli(home, "x", ["profile", "create", "stealth", "--mode", "debug"]);
    expect(changed.json.error?.code).toBe("bad_args");
  });
});
