import { describe, expect, it } from "vitest";
import { PopupFocusReturn, type FocusHost } from "../../src/focus.ts";

function fakeHost(frontmost: string[]): FocusHost & { returnedTo: string[]; clockMs: number } {
  const host = {
    returnedTo: [] as string[],
    clockMs: 0,
    frontmostBundleId: async () => frontmost.shift(),
    returnFocusFromChrome: (previous: string) => {
      host.returnedTo.push(previous);
    },
    nowMs: () => host.clockMs,
  };
  return host;
}

describe("PopupFocusReturn", () => {
  it("returns focus to the app in front when the request that opened the popup arrived", async () => {
    const host = fakeHost(["com.github.wez.wezterm"]);
    const focus = new PopupFocusReturn(1_000, host);
    focus.noteRequestArrived();
    await focus.returnAfterPopup();
    expect(host.returnedTo).toEqual(["com.github.wez.wezterm"]);
  });

  it("keeps the earlier app when a later request finds Chrome already in front", async () => {
    const host = fakeHost(["com.github.wez.wezterm", "com.google.Chrome"]);
    const focus = new PopupFocusReturn(1_000, host);
    focus.noteRequestArrived();
    host.clockMs = 800;
    focus.noteRequestArrived();
    await focus.returnAfterPopup();
    expect(host.returnedTo).toEqual(["com.github.wez.wezterm"]);
  });

  it("leaves focus alone when the user was in Chrome", async () => {
    const host = fakeHost(["com.google.Chrome"]);
    const focus = new PopupFocusReturn(1_000, host);
    focus.noteRequestArrived();
    await focus.returnAfterPopup();
    expect(host.returnedTo).toEqual([]);
  });

  it("leaves focus alone when the last app sample is older than 5 s", async () => {
    const host = fakeHost(["com.github.wez.wezterm"]);
    const focus = new PopupFocusReturn(1_000, host);
    focus.noteRequestArrived();
    host.clockMs = 6_000;
    await focus.returnAfterPopup();
    expect(host.returnedTo).toEqual([]);
  });

  it("does nothing without a host, as on Linux and WSL", async () => {
    const focus = new PopupFocusReturn(1_000, undefined);
    focus.noteRequestArrived();
    await expect(focus.returnAfterPopup()).resolves.toBeUndefined();
  });
});
