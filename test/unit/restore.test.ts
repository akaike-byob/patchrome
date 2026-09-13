import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { restoreSession, type CommandContext } from "../../src/commands.ts";
import { isClosedTargetRejection } from "../../src/daemon.ts";
import { PageDiagnostics } from "../../src/diagnostics.ts";
import type { BrowserEngine } from "../../src/engine.ts";
import { NetworkLog } from "../../src/network.ts";
import { RouteTable } from "../../src/routes.ts";
import { SessionRegistry, type SavedSession } from "../../src/sessions.ts";

class FakePage extends EventEmitter {
  readonly frame = {};
  address = "about:blank";
  isClosed = false;
  url() {
    return this.address;
  }
  mainFrame() {
    return this.frame;
  }
  async goto(url: string) {
    this.address = url;
  }
  async close() {
    this.isClosed = true;
    this.emit("close");
  }
}

function contextOpening(pagesBeforeFailure: number) {
  const opened: FakePage[] = [];
  const engine = {
    async openBackgroundPage() {
      if (opened.length === pagesBeforeFailure) throw new Error("browserContext.waitForEvent: Timeout 15000ms exceeded");
      const page = new FakePage();
      opened.push(page);
      return page;
    },
  } as unknown as BrowserEngine;
  const registry = new SessionRegistry();
  const ctx = {
    engine,
    registry,
    network: new NetworkLog(),
    routes: new RouteTable(),
    diagnostics: new PageDiagnostics(),
    trace: { owner: undefined },
    consoleCaptureReady: () => Promise.resolve(),
    sessionsDir: "/nonexistent",
  } as unknown as CommandContext;
  return { ctx, registry, opened };
}

const keeper: SavedSession = {
  name: "keeper",
  isIsolated: false,
  label: undefined,
  currentTabId: "t2",
  tabs: [
    { id: "t1", url: "https://one.test/" },
    { id: "t2", url: "https://two.test/" },
  ],
};

describe("restoreSession", () => {
  it("reopens every saved tab under its saved id", async () => {
    const { ctx, registry } = contextOpening(2);
    expect(await restoreSession(ctx, keeper, 1000)).toEqual({ restored: ["t1", "t2"], dropped: [] });
    expect(registry.currentTab("keeper").id).toBe("t2");
  });

  it("closes the tabs it opened when a later tab fails to open, and rethrows", async () => {
    const { ctx, registry, opened } = contextOpening(1);
    await expect(restoreSession(ctx, keeper, 1000)).rejects.toThrow("Timeout 15000ms");
    expect(opened.map((page) => page.isClosed)).toEqual([true]);
    expect(registry.hasSession("keeper")).toBe(false);
  });
});

describe("isClosedTargetRejection", () => {
  class ProtocolError extends Error {
    readonly type: string;
    constructor(type: string) {
      super("Protocol error (Network.setCacheDisabled): Internal server error, session closed.");
      this.type = type;
    }
  }

  it("matches a closed-session ProtocolError only", () => {
    expect(isClosedTargetRejection(new ProtocolError("closed"))).toBe(true);
    expect(isClosedTargetRejection(new ProtocolError("error"))).toBe(false);
    expect(isClosedTargetRejection(new Error("session closed"))).toBe(false);
    expect(isClosedTargetRejection("closed")).toBe(false);
  });
});
