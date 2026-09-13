import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

describe("widgets in cross-site iframes and closed shadow roots", () => {
  let fixture: FixtureServer;
  const home = makeHome("challenge");

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("detects a pending challenge, clicks through the closed shadow root, and sees it solved", async () => {
    expect((await runCli(home, "solver", ["open", `${fixture.origin}/captcha`])).json.ok).toBe(true);
    await runCli(home, "solver", ["wait", "--selector", "iframe"]);
    const pending = await runCli(home, "solver", ["challenge"]);
    expect(pending.json).toMatchObject({ ok: true, data: { state: "pending" } });

    const clicked = await runCli(home, "solver", ["click", "--selector", "#cb", "--frame", "iframe"]);
    expect(clicked.json.ok).toBe(true);
    const solved = await runCli(home, "solver", ["challenge"]);
    expect(solved.json).toMatchObject({ ok: true, data: { state: "solved" } });
    const token = await runCli(home, "solver", [
      "eval",
      "document.querySelector('[name=cf-turnstile-response]').value",
    ]);
    expect(token.json.data?.value).toBe("token-true");
  });

  it("types trusted keys into a field the snapshot cannot see", async () => {
    await runCli(home, "typist", ["open", `${fixture.origin}/captcha`]);
    await runCli(home, "typist", ["wait", "--selector", "iframe"]);
    expect((await runCli(home, "typist", ["click", "--selector", "#code", "--frame", "iframe"])).json.ok).toBe(true);
    expect((await runCli(home, "typist", ["type", "ab1"])).json.ok).toBe(true);
    const typed = await runCli(home, "typist", ["wait", "--text", "ab1 true"]);
    expect(typed.json.ok).toBe(true);
  });

  it("clicks a viewport point and reaches the iframe underneath", async () => {
    await runCli(home, "pointer", ["open", `${fixture.origin}/captcha`]);
    await runCli(home, "pointer", ["wait", "--selector", "iframe"]);
    const report = await runCli(home, "pointer", ["challenge"]);
    expect(report.json.data?.state).toBe("pending");
    // The checkbox sits at the iframe's top-left, inside its 8 px body margin.
    const frameBox = await runCli(home, "pointer", [
      "eval",
      "JSON.stringify(document.querySelector('iframe').getBoundingClientRect())",
    ]);
    const box = JSON.parse(String(frameBox.json.data?.value)) as { x: number; y: number };
    expect(
      (await runCli(home, "pointer", ["click", "--at", `${Math.round(box.x + 14)},${Math.round(box.y + 14)}`])).json.ok,
    ).toBe(true);
    expect((await runCli(home, "pointer", ["challenge"])).json.data?.state).toBe("solved");
  });

  it("shows a cross-site iframe's contents in the snapshot and clicks them by frame ref", async () => {
    await runCli(home, "reader", ["open", `${fixture.origin}/captcha?shadow=open`]);
    await runCli(home, "reader", ["wait", "--selector", "iframe"]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const snapshot = String((await runCli(home, "reader", ["snapshot", "--inline"])).json.data?.snapshot);
    const ref = snapshot.match(/checkbox "Verify you are human" \[ref=(f\d+e\d+)\]/)?.[1];
    expect(ref, snapshot).toBeDefined();
    expect((await runCli(home, "reader", ["click", `@${ref}`])).json.ok).toBe(true);
    expect((await runCli(home, "reader", ["challenge"])).json.data?.state).toBe("solved");
    const bad = await runCli(home, "reader", ["click", `@${ref}`, "--at", "1,1"]);
    expect(bad.json.error?.code).toBe("bad_args");
  });
});
