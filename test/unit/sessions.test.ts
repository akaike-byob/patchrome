import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CommandError } from "../../src/protocol.ts";
import { SessionRegistry, type TrackedPage } from "../../src/sessions.ts";

class FakePage extends EventEmitter {
  readonly frame = {};
  readonly address: string;
  constructor(address: string) {
    super();
    this.address = address;
  }
  url() {
    return this.address;
  }
  mainFrame() {
    return this.frame;
  }
}

const asTracked = (page: FakePage) => page as unknown as TrackedPage;

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof CommandError ? err.code : "not-a-command-error";
  }
  return undefined;
}

describe("SessionRegistry", () => {
  it("gives each session its own current tab", () => {
    const registry = new SessionRegistry();
    const a = registry.adoptPage("a", asTracked(new FakePage("https://a.test")), true);
    const b = registry.adoptPage("b", asTracked(new FakePage("https://b.test")), true);
    expect(registry.currentTab("a").id).toBe(a.id);
    expect(registry.currentTab("b").id).toBe(b.id);
    expect(registry.tabsOf("a").map((tab) => tab.url)).toEqual(["https://a.test"]);
  });

  it("reports tab_gone for a session with no tab", () => {
    expect(errorCodeOf(() => new SessionRegistry().currentTab("nobody"))).toBe("tab_gone");
  });

  it("reports tab_gone when the current page closes, without moving to another tab", () => {
    const registry = new SessionRegistry();
    registry.adoptPage("a", asTracked(new FakePage("https://one.test")), false);
    const page = new FakePage("https://two.test");
    registry.adoptPage("a", asTracked(page), true);
    page.emit("close");
    expect(errorCodeOf(() => registry.currentTab("a"))).toBe("tab_gone");
    expect(registry.tabsOf("a")).toHaveLength(1);
  });

  it("refuses another session's tab", () => {
    const registry = new SessionRegistry();
    const tab = registry.adoptPage("a", asTracked(new FakePage("https://a.test")), true);
    expect(errorCodeOf(() => registry.switchTo("b", tab.id))).toBe("bad_args");
    expect(errorCodeOf(() => registry.ownedTab("b", tab.id))).toBe("bad_args");
  });

  it("adds popups to the opener's session without making them current", () => {
    const registry = new SessionRegistry();
    const opener = new FakePage("https://a.test");
    const openerTab = registry.adoptPage("a", asTracked(opener), true);
    opener.emit("popup", new FakePage("https://popup.test"));
    expect(registry.tabsOf("a").map((tab) => tab.url)).toEqual(["https://a.test", "https://popup.test"]);
    expect(registry.currentTab("a").id).toBe(openerTab.id);
    expect(registry.tabsOf("b")).toEqual([]);
  });

  it("marks refs stale on main-frame navigation only", () => {
    const registry = new SessionRegistry();
    const page = new FakePage("https://a.test");
    const tab = registry.adoptPage("a", asTracked(page), true);
    tab.generations.recordSnapshot('- button "a" [ref=e1]');
    page.emit("framenavigated", {});
    expect(errorCodeOf(() => tab.generations.assertRefCurrent("e1"))).toBeUndefined();
    page.emit("framenavigated", page.frame);
    expect(errorCodeOf(() => tab.generations.assertRefCurrent("e1"))).toBe("ref_stale");
  });

  it("lists every session's tabs with --all", () => {
    const registry = new SessionRegistry();
    registry.adoptPage("a", asTracked(new FakePage("https://a.test")), true);
    registry.adoptPage("b", asTracked(new FakePage("https://b.test")), true);
    expect(registry.allTabs().map((tab) => tab.session)).toEqual(["a", "b"]);
  });
});
