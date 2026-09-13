import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

function daemonPidsFor(home: string): number[] {
  const table = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return table
    .split("\n")
    .filter((line) => line.includes("__daemon"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => {
      try {
        return execFileSync("ps", ["-Eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(home);
      } catch {
        return false;
      }
    });
}

describe("daemon lifecycle", () => {
  let fixture: FixtureServer;
  const home = makeHome("daemon");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("starts exactly one daemon when 3 CLI processes start at once", async () => {
    const results = await Promise.all(
      ["race-1", "race-2", "race-3"].map((session) => runCli(home, session, ["open", `${fixture.origin}/form?name=${session}`])),
    );
    for (const result of results) expect(result.json, result.stderr).toMatchObject({ ok: true });

    const tabIds = results.map((result) => result.json.data?.tab);
    expect(new Set(tabIds).size).toBe(3);

    const status = await runCli(home, "race-1", ["daemon", "status"]);
    expect(status.json.data).toMatchObject({ tabCount: 3 });
    expect(daemonPidsFor(home)).toEqual([status.json.data?.pid]);
    expect(existsSync(join(home, "stealth", "daemon.lock"))).toBe(false);
  });

  it("refuses commands from a CLI of another build, but still stops for it", async () => {
    const newer = { PATCHROME_BUILD_ID: "9.9.9+1" };
    const refused = await runCli(home, "upgrade", ["tabs"], newer);
    expect(refused.exitCode).toBe(1);
    expect(refused.json.error?.code).toBe("daemon_outdated");
    expect((await runCli(home, "upgrade", ["daemon", "status"], newer)).json).toMatchObject({ ok: true });
    expect((await runCli(home, "upgrade", ["daemon", "stop"], newer)).json).toMatchObject({ ok: true });
    const socketPath = join(home, "stealth", "daemon.sock");
    const deadlineMs = Date.now() + 15_000;
    while (existsSync(socketPath) && Date.now() < deadlineMs) await sleep(250);
    expect((await runCli(home, "upgrade", ["tabs"])).json).toMatchObject({ ok: true });
  });

  it("reports daemon_unreachable for status when nothing runs, without starting one", async () => {
    const emptyHome = makeHome("empty");
    const status = await runCli(emptyHome, "s", ["daemon", "status"]);
    expect(status.exitCode).toBe(1);
    expect(status.json.error?.code).toBe("daemon_unreachable");
    expect(existsSync(join(emptyHome, "stealth", "daemon.sock"))).toBe(false);
  });

  it("exits after the idle timeout and removes its socket", async () => {
    const idleHome = makeHome("idle");
    const opened = await runCli(idleHome, "s", ["open"], { PATCHROME_IDLE_MS: "3000" });
    expect(opened.json).toMatchObject({ ok: true });
    const socketPath = join(idleHome, "stealth", "daemon.sock");
    expect(existsSync(socketPath)).toBe(true);

    const deadlineMs = Date.now() + 30_000;
    while (existsSync(socketPath) && Date.now() < deadlineMs) await sleep(250);
    expect(existsSync(socketPath)).toBe(false);
    // Shutdown removes the socket first, then waits for Chrome to close before the process exits.
    while (daemonPidsFor(idleHome).length > 0 && Date.now() < deadlineMs) await sleep(250);
    expect(daemonPidsFor(idleHome)).toEqual([]);
  });

  it("does not go idle while a request outlasts the idle timeout", async () => {
    const busyHome = makeHome("busy");
    const idle = { PATCHROME_IDLE_MS: "2000" };
    expect((await runCli(busyHome, "s", ["open"], idle)).json).toMatchObject({ ok: true });
    const waited = await runCli(busyHome, "s", ["--timeout-ms", "5000", "wait", "--text", "never shown"], idle);
    expect(waited.json.error?.code).toBe("timeout");
    await runCli(busyHome, "s", ["daemon", "stop"], idle);
  });
});
