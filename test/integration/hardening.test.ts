import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startDaemonAnsweringCopies, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

interface TabRow {
  id: string;
  url: string;
  isCurrent: boolean;
}

async function waitForExit(pid: number): Promise<void> {
  const deadlineMs = Date.now() + 30_000;
  while (Date.now() < deadlineMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  throw new Error(`pid ${pid} still running after 30 s`);
}

describe("daemon restart and isolation", () => {
  let fixture: FixtureServer;
  const home = makeHome("hardening");
  const statePath = join(home, "iso-state.json");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("reopens a session's tabs under the same ids after the daemon is killed", async () => {
    await runCli(home, "keeper", ["open", `${fixture.origin}/form?name=one`]);
    await runCli(home, "keeper", ["open", `${fixture.origin}/form?name=two`]);
    await runCli(home, "keeper", ["switch", "t1"]);
    await runCli(home, "closer", ["open", `${fixture.origin}/form?name=gone`]);
    const pid = (await runCli(home, "keeper", ["daemon", "status"])).json.data?.pid as number;
    // The registry saves 100 ms after a change.
    await sleep(500);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);

    const status = await runCli(home, "fresh", ["daemon", "status"]);
    expect(status.json.data?.pid).not.toBe(pid);
    const tabs = (await runCli(home, "keeper", ["tabs"])).json.data?.tabs as TabRow[];
    expect(tabs.map((tab) => [tab.id, tab.url, tab.isCurrent])).toEqual([
      ["t1", `${fixture.origin}/form?name=one`, true],
      ["t2", `${fixture.origin}/form?name=two`, false],
    ]);
    expect((await runCli(home, "keeper", ["eval", "document.title"])).json.data?.value).toBe("form one");

    const opened = await runCli(home, "fresh", ["open"]);
    expect(opened.json.data?.tab).toBe("t4");

    expect((await runCli(home, "closer", ["session", "close"])).json.data?.closedTabs).toBe(0);
    expect((await runCli(home, "closer", ["tabs"])).json.data?.tabs).toEqual([]);
  });

  it("reopens tabs after a clean daemon stop too", async () => {
    const pid = (await runCli(home, "keeper", ["daemon", "status"])).json.data?.pid as number;
    await runCli(home, "keeper", ["daemon", "stop"]);
    await waitForExit(pid);
    const tabs = (await runCli(home, "keeper", ["tabs"])).json.data?.tabs as TabRow[];
    expect(tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect((await runCli(home, "closer", ["tabs"])).json.data?.tabs).toEqual([]);
  });

  it("prunes session folders older than 7 days when the daemon starts", async () => {
    const pruneHome = makeHome("prune");
    const sessionsDir = join(pruneHome, "stealth", "sessions");
    mkdirSync(join(sessionsDir, "stale"), { recursive: true });
    mkdirSync(join(sessionsDir, "current"), { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(sessionsDir, "stale"), eightDaysAgo, eightDaysAgo);
    expect((await runCli(pruneHome, "p", ["tabs"])).json).toMatchObject({ ok: true });
    expect(existsSync(join(sessionsDir, "stale"))).toBe(false);
    expect(existsSync(join(sessionsDir, "current"))).toBe(true);
    await stopDaemon(pruneHome);
  });

  it("keeps an isolated session's cookies apart from the shared profile in both directions", async () => {
    const isolatedLogin = await runCli(home, "iso", ["open", "--isolated", `${fixture.origin}/login`]);
    expect(isolatedLogin.json, isolatedLogin.stderr).toMatchObject({ ok: true });
    const isolatedCookies = (await runCli(home, "iso", ["cookies"])).json.data?.cookies as Array<{ name: string; value: string }>;
    expect(isolatedCookies.map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["sid=signed-in"]);
    expect((await runCli(home, "shared", ["cookies"])).json.data?.count).toBe(0);

    const saved = await runCli(home, "iso", ["state", "save", statePath]);
    expect(saved.json.data).toMatchObject({ cookies: 1 });
    await runCli(home, "shared", ["open", `${fixture.origin}/form?name=shared`]);

    // The restart tests below SIGKILL this home's spawned daemon, so the loads, which need an answered
    // approval, run in a daemon inside the test process.
    const loadHome = makeHome("isolation-load");
    await startDaemonAnsweringCopies(loadHome, "approved");
    await runCli(loadHome, "shared", ["open", `${fixture.origin}/form?name=shared`]);
    await runCli(loadHome, "shared", ["state", "load", statePath]);
    expect((await runCli(loadHome, "shared", ["cookies"])).json.data?.count).toBe(1);

    await runCli(loadHome, "iso2", ["open", "--isolated", `${fixture.origin}/form?name=iso2`]);
    expect((await runCli(loadHome, "iso2", ["cookies"])).json.data?.count).toBe(0);
    await runCli(loadHome, "iso2", ["state", "load", statePath]);
    expect((await runCli(loadHome, "iso2", ["cookies"])).json.data?.count).toBe(1);
    expect((await runCli(loadHome, "iso2", ["eval", "localStorage.getItem('token')"])).json.data?.value).toBe("t-123");
    await stopDaemon(loadHome);
  });

  it("refuses --isolated for a session that already browses the shared profile", async () => {
    const refused = await runCli(home, "shared", ["open", "--isolated"]);
    expect(refused.json.error?.code).toBe("bad_args");
    expect(refused.json.error?.message).toContain("already browses the shared profile");
  });

  it("gives an isolated session a fresh isolated context after a restart", async () => {
    const pid = (await runCli(home, "iso", ["daemon", "status"])).json.data?.pid as number;
    await sleep(500);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);
    const tabs = (await runCli(home, "iso", ["tabs"])).json.data?.tabs as TabRow[];
    expect(tabs.map((tab) => tab.id)).toHaveLength(1);
    await runCli(home, "iso", ["eval", "document.cookie = 'only=iso'", "--main-world"]);
    const isolatedNames = ((await runCli(home, "iso", ["cookies"])).json.data?.cookies as Array<{ name: string }>).map((cookie) => cookie.name);
    expect(isolatedNames).toContain("only");
    const sharedNames = ((await runCli(home, "shared", ["cookies"])).json.data?.cookies as Array<{ name: string }>).map((cookie) => cookie.name);
    expect(sharedNames).not.toContain("only");
  });
});
