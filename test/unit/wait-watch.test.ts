import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli.ts";
import { parseWatchEventKinds, watchEventLine } from "../../src/events.ts";
import { isNamePattern, nameGlobMatches } from "../../src/glob.ts";
import { protocolHelp, type ProtocolSchema } from "../../src/protocol-help.ts";
import { CommandError } from "../../src/protocol.ts";
import { parseWaitCondition } from "../../src/wait.ts";

const parse = (argv: string[]) => parseCli(argv, {}, () => "fallback-session");

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof CommandError ? err.code : "not-a-command-error";
  }
  return undefined;
}

describe("wait conditions", () => {
  it("takes exactly one condition, with --gone flipping it", () => {
    expect(parseWaitCondition({ title: "Prove your humanity", gone: true })).toEqual({ kind: "title", text: "Prove your humanity", isGone: true });
    expect(parseWaitCondition({ selector: "#posts", gone: false })).toEqual({ kind: "element", locator: { kind: "selector", selector: "#posts", frame: undefined, nth: undefined }, isGone: false });
    expect(parseWaitCondition({ role: "button", name: "Next", gone: true })).toEqual({ kind: "element", locator: { kind: "role", role: "button", name: "Next", isExact: false, frame: undefined, nth: undefined }, isGone: true });
    expect(parseWaitCondition({ url: "*/done*" })).toEqual({ kind: "url", glob: "*/done*", isGone: false });
    expect(parseWaitCondition({ load: "networkidle" })).toEqual({ kind: "load", state: "networkidle" });
    for (const args of [{}, { text: "a", title: "b" }, { load: "soon" }, { load: "load", gone: true }, { selector: "" }, { role: "button", url: "*" }, { name: "Next" }]) {
      expect(errorCodeOf(() => parseWaitCondition(args)), JSON.stringify(args)).toBe("bad_args");
    }
  });
});

describe("watch events", () => {
  it("defaults to what the profile can see and refuses Runtime events in stealth", () => {
    expect(parseWatchEventKinds(undefined, "stealth")).toEqual(["navigation", "load", "response"]);
    expect(parseWatchEventKinds(undefined, "debug")).toEqual(["navigation", "load", "response", "console", "error"]);
    expect(parseWatchEventKinds("load, response", "stealth")).toEqual(["load", "response"]);
    expect(errorCodeOf(() => parseWatchEventKinds("console", "stealth"))).toBe("unsupported_in_stealth");
    expect(errorCodeOf(() => parseWatchEventKinds("clicks", "debug"))).toBe("bad_args");
  });

  it("prints one line per event", () => {
    expect(watchEventLine({ kind: "navigation", tabId: "t2", url: "https://a.test/", atMs: 0 })).toBe("navigation t2 https://a.test/");
  });
});

describe("session name patterns", () => {
  it("matches *, ? and classes, and treats a plain name as literal", () => {
    expect(isNamePattern("work-1")).toBe(false);
    expect(nameGlobMatches("work-1", "work-1")).toBe(true);
    expect(nameGlobMatches("work-1", "work-10")).toBe(false);
    expect(nameGlobMatches("work-*", "work-10")).toBe(true);
    expect(nameGlobMatches("work-?", "work-10")).toBe(false);
    expect(nameGlobMatches("work-[12]", "work-2")).toBe(true);
    expect(nameGlobMatches("work-[!12]", "work-2")).toBe(false);
    expect(nameGlobMatches("a.b*", "axb")).toBe(false);
  });
});

describe("cdp help", () => {
  const schema: ProtocolSchema = {
    domains: [{
      domain: "Page",
      description: "Actions and events related to the inspected page.\nMore text.",
      commands: [{ name: "navigate", description: "Navigates current page to the given URL.", parameters: [{ name: "url", type: "string", description: "URL to navigate the page to." }, { name: "transitionType", $ref: "TransitionType", optional: true }], returns: [{ name: "frameId", $ref: "FrameId" }] }],
      events: [{ name: "loadEventFired", parameters: [{ name: "timestamp", $ref: "Network.MonotonicTime" }] }],
    }, { domain: "WebMCP", experimental: true, commands: [], events: [] }],
  };

  it("lists domains, a domain's members, and one member's params", () => {
    expect(protocolHelp(schema, undefined)).toEqual(["Page  1 commands, 1 events", "WebMCP [experimental]  0 commands, 0 events"]);
    expect(protocolHelp(schema, "page")).toContain("  Page.navigate  Navigates current page to the given URL.");
    expect(protocolHelp(schema, "Page.navigate")).toEqual([
      "command Page.navigate",
      "Navigates current page to the given URL.",
      "",
      "params",
      "  url: string  URL to navigate the page to.",
      "  transitionType?: TransitionType",
      "",
      "returns",
      "  frameId: FrameId",
    ]);
    expect(protocolHelp(schema, "Page.loadEventFired")[0]).toBe("event Page.loadEventFired");
    expect(errorCodeOf(() => protocolHelp(schema, "Nope"))).toBe("bad_args");
    expect(errorCodeOf(() => protocolHelp(schema, "Page.fly"))).toBe("bad_args");
  });
});

describe("parseCli for wait, watch, sessions and completions", () => {
  it("maps the new commands", () => {
    expect(parse(["wait", "--title", "Prove your humanity", "--gone"])).toMatchObject({ command: "wait", timeoutMs: 30_000, args: { title: "Prove your humanity", gone: true } });
    expect(parse(["watch", "--events", "response", "--url", "*api*", "--count", "2"])).toMatchObject({ command: "watch", timeoutMs: 600_000, args: { events: "response", url: "*api*", count: 2 } });
    expect(parse(["cdp", "help", "Page.navigate"])).toMatchObject({ command: "cdp-help", args: { topic: "Page.navigate" } });
    expect(parse(["cdp", "help"])).toMatchObject({ command: "cdp-help", args: { topic: undefined } });
    expect(parse(["sessions", "work-*"])).toMatchObject({ command: "sessions", args: { pattern: "work-*" }, shouldStartDaemon: false });
    expect(parse(["session", "close", "work-*"])).toMatchObject({ command: "session-close", args: { pattern: "work-*" }, shouldStartDaemon: false });
    expect(parse(["completions", "zsh"])).toEqual({ kind: "completions", shell: "zsh" });
    for (const argv of [["watch", "--count", "0"], ["completions", "fish"], ["wait", "extra"]]) expect(errorCodeOf(() => parse(argv)), argv.join(" ")).toBe("bad_args");
  });
});
