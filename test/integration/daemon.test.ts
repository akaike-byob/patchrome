import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromeHost,
  daemonPidsFor,
  makeHome,
  runCli,
  startFixtureServer,
  stopDaemon,
  type FixtureServer,
} from "./helpers.ts";

// Sets up a home whose Chrome launch fails before anything slow runs, so the failure comes before a starter
// connects.
function launchFailureIn(home: string): { env: NodeJS.ProcessEnv; code: string; message: RegExp } {
  switch (chromeHost) {
    case "local":
      // The launch removes a stale DevToolsActivePort file first; a folder in its place fails that at once.
      mkdirSync(join(home, "stealth", "chrome-profile", "DevToolsActivePort", "stuck"), { recursive: true });
      return { env: {}, code: "bad_args", message: /is a directory/ };
    case "windows": {
      // The networking check runs before PowerShell.
      const fakeBin = join(home, "bin");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "wslinfo"), "#!/bin/sh\necho nat\n", { mode: 0o755 });
      return {
        env: { PATH: `${fakeBin}:${process.env.PATH}` },
        code: "setup_required",
        message: /WSL networking mode is nat/,
      };
    }
  }
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
      ["race-1", "race-2", "race-3"].map((session) =>
        runCli(home, session, ["open", `${fixture.origin}/form?name=${session}`]),
      ),
    );
    for (const result of results) expect(result.json, result.stderr).toMatchObject({ ok: true });

    const tabIds = results.map((result) => result.json.data?.tab);
    expect(new Set(tabIds).size).toBe(3);

    const status = await runCli(home, "race-1", ["daemon", "status"]);
    expect(status.json.data).toMatchObject({ tabCount: 3 });
    expect(daemonPidsFor(home)).toEqual([status.json.data?.pid]);
    expect(existsSync(join(home, "stealth", "daemon.lock"))).toBe(false);
  });

  it("refuses commands from an older CLI, but still stops for it", async () => {
    const older = { PATCHROME_BUILD_ID: "0.0.0-development+1" };
    const refused = await runCli(home, "upgrade", ["tabs"], older);
    expect(refused.exitCode).toBe(1);
    expect(refused.json.error?.code).toBe("daemon_outdated");
    expect(refused.json.error?.hint).toMatch(/patchrome@latest/);
    expect((await runCli(home, "upgrade", ["daemon", "status"], older)).json).toMatchObject({ ok: true });
    expect((await runCli(home, "upgrade", ["daemon", "stop"], older)).json).toMatchObject({ ok: true });
    const socketPath = join(home, "stealth", "daemon.sock");
    const deadlineMs = Date.now() + 15_000;
    while (existsSync(socketPath) && Date.now() < deadlineMs) await sleep(250);
    expect((await runCli(home, "upgrade", ["tabs"])).json).toMatchObject({ ok: true });
  });

  it("replaces an older daemon when a newer CLI arrives, and gives other sessions their tabs back", async () => {
    const opened = await runCli(home, "bystander", ["open", `${fixture.origin}/form?name=bystander`]);
    expect(opened.json).toMatchObject({ ok: true });
    const oldPid = (await runCli(home, "bystander", ["daemon", "status"])).json.data?.pid;

    const newer = { PATCHROME_BUILD_ID: "0.0.0-development+99999999999999" };
    const listed = await runCli(home, "upgrade", ["tabs"], newer);
    expect(listed.json, listed.stderr).toMatchObject({ ok: true });
    const status = await runCli(home, "upgrade", ["daemon", "status"], newer);
    expect(status.json.data).toMatchObject({ buildId: newer.PATCHROME_BUILD_ID });
    expect(status.json.data?.pid).not.toBe(oldPid);
    expect(daemonPidsFor(home)).toEqual([status.json.data?.pid]);

    const restored = await runCli(home, "bystander", ["tabs"], newer);
    expect(restored.json.data?.tabs).toEqual([expect.objectContaining({ id: opened.json.data?.tab })]);
    await stopDaemon(home);
  });

  it("reports daemon_unreachable for status when nothing runs, without starting one", async () => {
    const emptyHome = makeHome("empty");
    const status = await runCli(emptyHome, "s", ["daemon", "status"]);
    expect(status.exitCode).toBe(1);
    expect(status.json.error?.code).toBe("daemon_unreachable");
    expect(existsSync(join(emptyHome, "stealth", "daemon.sock"))).toBe(false);
  });

  it("tells every starter why Chrome failed to launch, even when it fails before anyone connects", async () => {
    const brokenHome = makeHome("broken-launch");
    const { env, code, message } = launchFailureIn(brokenHome);
    for (const attempt of [1, 2, 3]) {
      const startedAtMs = Date.now();
      const opened = await runCli(brokenHome, `broken-${attempt}`, ["open"], env);
      // A starter that missed the answer would spawn daemon after daemon until its 30 s start timeout.
      expect(Date.now() - startedAtMs).toBeLessThan(5_000);
      expect(opened.json.error?.code, opened.stdout).toBe(code);
      expect(opened.json.error?.message).toMatch(message);
    }
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

  it("answers status and stop from a session whose queue a long command holds", async () => {
    const stuckHome = makeHome("stuck");
    expect((await runCli(stuckHome, "s", ["open"])).json).toMatchObject({ ok: true });
    const waiting = runCli(stuckHome, "s", ["--timeout-ms", "60000", "wait", "--text", "never shown"]);
    // Long enough for the waiting CLI to start and reach the daemon first.
    await sleep(3000);
    const status = await runCli(stuckHome, "s", ["daemon", "status"]);
    expect(status.json).toMatchObject({ ok: true });
    const stopped = await runCli(stuckHome, "s", ["daemon", "stop"]);
    expect(stopped.json).toMatchObject({ ok: true });
    // The stop ends the wait long before its own timeout would.
    expect((await waiting).json.error?.code).toBe("tab_gone");
  });
});
