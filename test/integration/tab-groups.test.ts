import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

interface TabGroupRow {
  title: string;
  color: string;
  tabCount: number;
}

describe("chrome tab groups per session", () => {
  let fixture: FixtureServer;
  const home = makeHome("tab-groups");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  const tabGroupsOf = async (session: string) => (await runCli(home, session, ["session"])).json.data?.tabGroups as TabGroupRow[];

  it("groups each session's tabs under its name, and a label joins the title", async () => {
    await runCli(home, "agent-a", ["open", `${fixture.origin}/form?name=one`]);
    await runCli(home, "agent-a", ["open", `${fixture.origin}/form?name=two`]);
    await runCli(home, "agent-b", ["open", `${fixture.origin}/form?name=three`]);

    const groupsA = await tabGroupsOf("agent-a");
    expect(groupsA.map((group) => [group.title, group.tabCount])).toEqual([["agent-a", 2]]);
    expect((await tabGroupsOf("agent-b")).map((group) => [group.title, group.tabCount])).toEqual([["agent-b", 1]]);

    const labelled = await runCli(home, "agent-a", ["session", "label", "checkout flow"]);
    expect(labelled.json).toMatchObject({ ok: true, data: { label: "checkout flow" } });
    const relabelled = await tabGroupsOf("agent-a");
    expect(relabelled).toEqual([{ title: "agent-a: checkout flow", color: groupsA[0]?.color, tabCount: 2 }]);

    await runCli(home, "agent-a", ["open"]);
    expect((await tabGroupsOf("agent-a")).map((group) => [group.title, group.tabCount])).toEqual([["agent-a: checkout flow", 3]]);
  });

  it("puts a popup in its opener's group", async () => {
    await runCli(home, "agent-c", ["open", `${fixture.origin}/popup`]);
    const snapshot = (await runCli(home, "agent-c", ["snapshot", "--inline"])).json.data?.snapshot as string;
    const ref = snapshot.match(/link "Open popup" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeDefined();
    await runCli(home, "agent-c", ["click", ref ?? ""]);
    await expect.poll(async () => (await runCli(home, "agent-c", ["tabs"])).json.data?.tabs, { timeout: 10_000 }).toHaveLength(2);
    expect((await tabGroupsOf("agent-c")).map((group) => [group.title, group.tabCount])).toEqual([["agent-c", 2]]);
  });

  it("leaves an isolated session ungrouped, since its browser context is out of the extension's reach", async () => {
    const opened = await runCli(home, "agent-iso", ["open", "--isolated", `${fixture.origin}/form?name=iso`]);
    expect(opened.json).toMatchObject({ ok: true });
    expect(await tabGroupsOf("agent-iso")).toEqual([]);
    const logs = (await runCli(home, "agent-iso", ["daemon", "logs"], {}, false)).stdout;
    expect(logs).not.toContain("tab grouping failed");
  });

  it("keeps the label and regroups restored tabs after a restart", async () => {
    const pid = (await runCli(home, "agent-a", ["daemon", "status"])).json.data?.pid as number;
    await runCli(home, "agent-a", ["daemon", "stop"]);
    const deadlineMs = Date.now() + 30_000;
    while (Date.now() < deadlineMs && (await runCli(home, "probe", ["daemon", "status"])).json.data?.pid === pid) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const session = (await runCli(home, "agent-a", ["session"])).json.data;
    expect(session?.label).toBe("checkout flow");
    expect((session?.tabGroups as TabGroupRow[]).map((group) => [group.title, group.tabCount])).toEqual([["agent-a: checkout flow", 3]]);
  });
});
