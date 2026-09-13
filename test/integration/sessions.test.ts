import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

describe("sessions and commands in one shared Chrome", () => {
  let fixture: FixtureServer;
  const home = makeHome("sessions");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("keeps each session on its own tab while both work at once", async () => {
    const [alpha, beta] = await Promise.all([
      runCli(home, "alpha", ["open", `${fixture.origin}/form?name=alpha`]),
      runCli(home, "beta", ["open", `${fixture.origin}/form?name=beta`]),
    ]);
    expect(alpha.json).toMatchObject({ ok: true });
    expect(beta.json).toMatchObject({ ok: true });

    for (let round = 0; round < 3; round++) {
      const [alphaText, betaText] = await Promise.all([
        runCli(home, "alpha", ["text"]),
        runCli(home, "beta", ["text"]),
      ]);
      expect(alphaText.json.data?.text).toContain("alpha");
      expect(alphaText.json.data?.text).not.toContain("beta");
      expect(betaText.json.data?.text).toContain("beta");
    }

    const betaTabs = await runCli(home, "beta", ["tabs"]);
    expect(betaTabs.json.data?.tabs).toHaveLength(1);
    const allTabs = await runCli(home, "beta", ["tabs", "--all"]);
    expect((allTabs.json.data?.tabs as unknown[]).length).toBeGreaterThanOrEqual(2);

    const steal = await runCli(home, "beta", ["switch", String(alpha.json.data?.tab)]);
    expect(steal.exitCode).toBe(2);
    expect(steal.json.error?.code).toBe("bad_args");
  });

  it("runs the snapshot, fill, click loop and reports ref_stale after navigation", async () => {
    await runCli(home, "loop", ["open", `${fixture.origin}/form?name=loop`]);
    const snapshot = await runCli(home, "loop", ["snapshot"]);
    expect(snapshot.json).toMatchObject({ ok: true });
    const tree = readFileSync(String(snapshot.json.data?.path), "utf8");
    const textboxRef = tree.match(/textbox "Name" \[ref=([^\]]+)\]/)?.[1];
    const buttonRef = tree.match(/button "Greet" \[ref=([^\]]+)\]/)?.[1];
    expect(textboxRef).toBeDefined();
    expect(buttonRef).toBeDefined();

    expect((await runCli(home, "loop", ["fill", `@${textboxRef}`, "ada"])).json).toMatchObject({ ok: true });
    expect((await runCli(home, "loop", ["click", `@${buttonRef}`])).json).toMatchObject({ ok: true });
    const evaluated = await runCli(home, "loop", ["eval", "document.querySelector('#out').textContent"]);
    expect(evaluated.json.data?.value).toBe("hello ada");

    await runCli(home, "loop", ["goto", `${fixture.origin}/popup`]);
    const stale = await runCli(home, "loop", ["click", `@${buttonRef}`]);
    expect(stale.exitCode).toBe(1);
    expect(stale.json.error?.code).toBe("ref_stale");

    // The M1 agent run hit this: a newer snapshot exists, but the ref was copied from the page before.
    await runCli(home, "loop", ["snapshot"]);
    const fromOlderSnapshot = await runCli(home, "loop", ["click", `@${textboxRef}`]);
    expect(fromOlderSnapshot.json.error?.code).toBe("ref_stale");
  });

  it("adds a popup to the clicking session only", async () => {
    await runCli(home, "opener", ["open", `${fixture.origin}/popup`]);
    const snapshot = await runCli(home, "opener", ["snapshot", "--inline"]);
    const linkRef = String(snapshot.json.data?.snapshot).match(/link "Open popup" \[ref=([^\]]+)\]/)?.[1];
    expect((await runCli(home, "opener", ["click", `@${linkRef}`])).json).toMatchObject({ ok: true });

    let tabs: unknown[] = [];
    for (let attempt = 0; attempt < 20 && tabs.length < 2; attempt++) {
      tabs = (await runCli(home, "opener", ["tabs"])).json.data?.tabs as unknown[];
    }
    expect(tabs).toHaveLength(2);
    expect((await runCli(home, "bystander", ["tabs"])).json.data?.tabs).toEqual([]);
  });

  it("reports tab_gone when the current tab closes, and does not move to another tab", async () => {
    await runCli(home, "closer", ["open", `${fixture.origin}/form?name=first`]);
    await runCli(home, "closer", ["open", `${fixture.origin}/form?name=second`]);
    expect((await runCli(home, "closer", ["close"])).json).toMatchObject({ ok: true });
    const afterClose = await runCli(home, "closer", ["text"]);
    expect(afterClose.exitCode).toBe(1);
    expect(afterClose.json.error?.code).toBe("tab_gone");
  });

  // Chrome lets a script close only a window with one history entry, so the self-closing page is a popup.
  it("reports tab_gone when the page closes itself", async () => {
    await runCli(home, "selfclose", ["open", `${fixture.origin}/popup`]);
    const snapshot = await runCli(home, "selfclose", ["snapshot", "--inline"]);
    const linkRef = String(snapshot.json.data?.snapshot).match(/link "Open popup" \[ref=([^\]]+)\]/)?.[1];
    await runCli(home, "selfclose", ["click", `@${linkRef}`]);
    let popupId: string | undefined;
    for (let attempt = 0; attempt < 20 && popupId === undefined; attempt++) {
      const tabs = (await runCli(home, "selfclose", ["tabs"])).json.data?.tabs as Array<{ id: string; isCurrent: boolean }>;
      popupId = tabs.find((tab) => !tab.isCurrent)?.id;
    }
    expect((await runCli(home, "selfclose", ["switch", String(popupId)])).json).toMatchObject({ ok: true });
    await runCli(home, "selfclose", ["eval", "window.close()", "--main-world"]);
    const afterClose = await runCli(home, "selfclose", ["text"]);
    expect(afterClose.json.error?.code).toBe("tab_gone");
  });

  it("maps a navigation past --timeout-ms to timeout", async () => {
    await runCli(home, "slow", ["open"]);
    const slow = await runCli(home, "slow", ["--timeout-ms", "1000", "goto", `${fixture.origin}/slow`]);
    expect(slow.exitCode).toBe(1);
    expect(slow.json.error?.code).toBe("timeout");
  });

  it("writes output over 2 KB to a session file and a screenshot to disk", async () => {
    await runCli(home, "files", ["open", `${fixture.origin}/long`]);
    const text = await runCli(home, "files", ["text"]);
    expect(text.json.data?.bytes).toBeGreaterThan(2048);
    expect(readFileSync(String(text.json.data?.path), "utf8")).toContain("lorem ipsum");

    const screenshot = await runCli(home, "files", ["screenshot"]);
    const png = readFileSync(String(screenshot.json.data?.path));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("closes the new tab when open fails to navigate", async () => {
    const failed = await runCli(home, "unreachable", ["open", "http://127.0.0.1:1/"]);
    expect(failed.json.error?.code).toBe("navigation_failed");
    expect((await runCli(home, "unreachable", ["tabs"])).json.data?.tabs).toEqual([]);
  });

  it("closes a session's tabs and forgets it", async () => {
    await runCli(home, "done", ["open", `${fixture.origin}/form?name=done`]);
    expect((await runCli(home, "done", ["session", "close"])).json).toMatchObject({ ok: true, data: { closedTabs: 1 } });
    expect((await runCli(home, "done", ["tabs"])).json.data?.tabs).toEqual([]);
  });
});
