import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

const binPath = fileURLToPath(new URL("../../bin/patchrome.js", import.meta.url));

describe("wait, watch and session patterns", () => {
  let fixture: FixtureServer;
  const home = makeHome("wait-watch");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("waits out an interstitial title, then sees the page behind it", async () => {
    expect((await runCli(home, "waiter", ["open", `${fixture.origin}/challenge`])).json.data?.title).toBe(
      "Prove your humanity",
    );
    const waited = await runCli(home, "waiter", ["wait", "--title", "Prove your humanity", "--gone"]);
    expect(waited.json).toMatchObject({ ok: true, data: { title: "programming" } });
    // A 1 ms timeout passes only when the wait reads the element as already visible instead of waiting for it.
    // A time budget on waitedMs would fail on a loaded runner, where Chrome can take 1.8 s to answer one CDP call.
    const posts = await runCli(home, "waiter", ["--timeout-ms", "1", "wait", "--selector", "#posts li"]);
    expect(posts.json, posts.stdout + posts.stderr).toMatchObject({ ok: true });
    const missing = await runCli(home, "waiter", ["--timeout-ms", "1", "wait", "--selector", "#posts li.never"]);
    expect(missing.json.error?.code).toBe("timeout");
  });

  it("fails a wait with timeout and says where the tab is", async () => {
    await runCli(home, "impatient", ["open", `${fixture.origin}/form?name=still`]);
    const missing = await runCli(home, "impatient", ["--timeout-ms", "800", "wait", "--text", "never shown"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.json.error?.code).toBe("timeout");
    expect(missing.json.error?.hint).toContain("/form?name=still");
    const badSelector = await runCli(home, "impatient", ["wait", "--selector", "[[nope"]);
    expect(badSelector.json.error?.code).toBe("bad_args");
  });

  it("streams navigation and responses, and stops after --count", async () => {
    await runCli(home, "watcher", ["open", `${fixture.origin}/form?name=start`]);
    const streamed = new Promise<string[]>((resolve) => {
      execFile(
        process.execPath,
        [binPath, "--session", "watcher", "watch", "--events", "response", "--url", "*/api/items", "--count", "1"],
        {
          env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" },
          timeout: 60_000,
        },
        (_err, stdout) => resolve(stdout.trim().split("\n")),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await runCli(home, "watcher", ["goto", `${fixture.origin}/shop`])).json.ok).toBe(true);
    const lines = await streamed;
    expect(lines[0]).toMatch(/^response n\d+ t\d+ 200 fetch GET http:\/\/127\.0\.0\.1:\d+\/api\/items \d+ms$/);
    expect(lines.at(-1)).toBe("watched 1 events, stopped on count");

    const stealthConsole = await runCli(home, "watcher", ["watch", "--events", "console"]);
    expect(stealthConsole.json.error?.code).toBe("unsupported_in_stealth");
  });

  it("lists sessions and closes them by glob, never by prefix", async () => {
    await Promise.all(
      ["work-1", "work-10", "work-2", "other"].map((name) =>
        runCli(home, name, ["open", `${fixture.origin}/form?name=${name}`]),
      ),
    );
    const listed = await runCli(home, "other", ["sessions", "work-*"]);
    expect((listed.json.data?.sessions as Array<{ session: string }>).map((entry) => entry.session)).toEqual([
      "work-1",
      "work-10",
      "work-2",
    ]);

    const literal = await runCli(home, "other", ["session", "close", "work-1"]);
    expect(literal.json.data?.sessions).toEqual([{ session: "work-1", closedTabs: 1 }]);
    const pattern = await runCli(home, "other", ["session", "close", "work-*"]);
    expect(pattern.json.data?.sessions).toEqual([
      { session: "work-10", closedTabs: 1 },
      { session: "work-2", closedTabs: 1 },
    ]);
    expect((await runCli(home, "other", ["session", "close", "work-*"])).json.error?.code).toBe("bad_args");
    expect((await runCli(home, "other", ["tabs"])).json.data?.tabs).toHaveLength(1);
  });
});
