import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli.ts";
import { CommandError, errorCodes, exitCodeFor } from "../../src/protocol.ts";

const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseCli(argv, env, () => "fallback-session");

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof CommandError ? err.code : "not-a-command-error";
  }
  return undefined;
}

describe("parseCli", () => {
  it("applies defaults for profile, session and timeout", () => {
    expect(parse(["open", "https://a.test"])).toMatchObject({
      profile: "stealth",
      session: "fallback-session",
      timeoutMs: 30_000,
      command: "open",
      args: { url: "https://a.test" },
      shouldStartDaemon: true,
    });
  });

  it("reads global flags", () => {
    expect(
      parse(["--profile", "work", "--session", "s1", "--json", "--timeout-ms", "500", "fill", "@e2", "hi"]),
    ).toMatchObject({
      profile: "work",
      session: "s1",
      isJson: true,
      timeoutMs: 500,
      command: "fill",
      args: { ref: "@e2", fillText: "hi" },
    });
  });

  it("maps two-word lifecycle commands and does not start a daemon for them", () => {
    expect(parse(["session", "close"])).toMatchObject({ command: "session-close", shouldStartDaemon: false });
    expect(parse(["daemon", "status"])).toMatchObject({ command: "daemon-status", shouldStartDaemon: false });
    expect(parse(["daemon", "logs"])).toEqual({ kind: "logs", profile: "stealth", isJson: false });
  });

  it("maps session label to its text and needs the text", () => {
    expect(parse(["session", "label", "checkout flow"])).toMatchObject({
      command: "session-label",
      args: { label: "checkout flow" },
      shouldStartDaemon: true,
    });
    expect(() => parse(["session", "label"])).toThrow("session needs <text>");
  });

  it("passes --main-world through to eval", () => {
    expect(parse(["eval", "1+1", "--main-world"])).toMatchObject({
      command: "eval",
      args: { js: "1+1", mainWorld: true },
    });
  });

  it("rejects bad usage as bad_args", () => {
    const badInputs = [
      [],
      ["fly"],
      ["click"],
      ["fill", "@e1"],
      ["goto", "a", "b"],
      ["daemon", "restart"],
      ["--timeout-ms", "soon", "tabs"],
      ["--profile", "../etc", "tabs"],
    ];
    for (const argv of badInputs)
      expect(
        errorCodeOf(() => parse(argv)),
        argv.join(" "),
      ).toBe("bad_args");
  });

  it("rejects unknown flags", () => {
    expect(() => parse(["tabs", "--everything"])).toThrow("Unknown option '--everything'");
  });
});

describe("exitCodeFor", () => {
  it("returns 2 for bad usage and 1 for every other error", () => {
    for (const code of errorCodes) expect(exitCodeFor(code)).toBe(code === "bad_args" ? 2 : 1);
  });
});

describe("parseCli for M2 commands", () => {
  it("maps network, route and state subcommands and makes file paths absolute", () => {
    expect(parse(["network", "list", "--url", "*api*", "--type", "fetch", "--status", "4xx"])).toMatchObject({
      command: "network-list",
      args: { url: "*api*", type: "fetch", status: "4xx" },
    });
    expect(parse(["network", "get", "n4", "--body"])).toMatchObject({
      command: "network-get",
      args: { id: "n4", body: true },
    });
    expect(parse(["network", "har", "stop"])).toMatchObject({ command: "network-har-stop" });
    expect(parse(["route", "mock", "*/api", "mock.json"])).toMatchObject({
      command: "route-mock",
      args: { glob: "*/api", file: `${process.cwd()}/mock.json` },
    });
    expect(parse(["state", "save", "s.json"])).toMatchObject({
      command: "state-save",
      args: { file: `${process.cwd()}/s.json` },
    });
    expect(parse(["extract", "schema.json"])).toMatchObject({ args: { schema: `${process.cwd()}/schema.json` } });
    expect(parse(["extract", '{"fields": {"a": "h1"}}'])).toMatchObject({
      args: { schema: '{"fields": {"a": "h1"}}' },
    });
  });

  it("gives login 10 minutes unless --timeout-ms says otherwise", () => {
    expect(parse(["login", "https://a.test"])).toMatchObject({ timeoutMs: 600_000, args: { url: "https://a.test" } });
    expect(parse(["login", "https://a.test", "--timeout-ms", "5000"])).toMatchObject({ timeoutMs: 5000 });
  });

  it("maps state import with the CLI's Chrome user data dir and gives it 2 minutes", () => {
    expect(
      parse(["state", "import", "github.com", "--from", "Profile 1"], { PATCHROME_CHROME_USER_DATA_DIR: "/chrome" }),
    ).toMatchObject({
      command: "state-import",
      timeoutMs: 120_000,
      args: { site: "github.com", from: "Profile 1", chromeUserDataDir: "/chrome" },
    });
    // Without one, the daemon picks the everyday Chrome where its own Chrome runs, which on WSL is Windows.
    expect(parse(["state", "import", "github.com"], {})).toMatchObject({ args: { chromeUserDataDir: undefined } });
    expect(errorCodeOf(() => parse(["state", "import"]))).toBe("bad_args");
  });

  it("maps state export to a site and an absolute file", () => {
    expect(parse(["state", "export", "github.com", "gh.json"])).toMatchObject({
      command: "state-export",
      args: { site: "github.com", file: `${process.cwd()}/gh.json` },
    });
    expect(errorCodeOf(() => parse(["state", "export", "github.com"]))).toBe("bad_args");
    expect(errorCodeOf(() => parse(["state", "export", "github.com", "gh.json", "extra"]))).toBe("bad_args");
  });

  it("rejects unknown subcommands", () => {
    for (const argv of [
      ["network", "watch"],
      ["network", "har", "pause"],
      ["route", "allow", "*"],
      ["state", "merge", "f"],
    ]) {
      expect(
        errorCodeOf(() => parse(argv)),
        argv.join(" "),
      ).toBe("bad_args");
    }
  });
});

describe("parseCli for M3 commands", () => {
  it("maps debug commands", () => {
    expect(parse(["console", "--level", "error"])).toMatchObject({
      command: "console",
      timeoutMs: 30_000,
      args: { level: "error", follow: false },
    });
    expect(parse(["console", "--follow"])).toMatchObject({
      command: "console",
      timeoutMs: 600_000,
      args: { follow: true },
    });
    expect(parse(["errors"])).toMatchObject({ command: "errors" });
    expect(parse(["trace", "start"])).toMatchObject({ command: "trace-start" });
    expect(parse(["cdp", "Performance.getMetrics"])).toMatchObject({
      command: "cdp",
      args: { method: "Performance.getMetrics", params: undefined },
    });
    expect(parse(["cdp", "Runtime.evaluate", '{"expression": "1"}'])).toMatchObject({
      args: { params: '{"expression": "1"}' },
    });
    expect(parse(["devtools-url"])).toMatchObject({ command: "devtools-url" });
  });

  it("handles profile create locally and requires a valid mode", () => {
    expect(parse(["profile", "create", "work", "--mode", "debug"])).toEqual({
      kind: "create-profile",
      profile: "work",
      mode: "debug",
      isJson: false,
    });
    for (const argv of [
      ["profile", "create", "work"],
      ["profile", "create", "work", "--mode", "loud"],
      ["profile", "delete", "work"],
      ["trace", "pause"],
    ]) {
      expect(
        errorCodeOf(() => parse(argv)),
        argv.join(" "),
      ).toBe("bad_args");
    }
  });
});

describe("parseCli for scripting", () => {
  it("passes locators to acts and reads, with fill text as the only positional", () => {
    expect(parse(["click", "--role", "button", "--name", "Sign in", "--exact"])).toMatchObject({
      command: "click",
      args: { role: "button", name: "Sign in", exact: true, ref: undefined },
    });
    expect(parse(["fill", "--label", "Email", "ada@example.test"])).toMatchObject({
      command: "fill",
      args: { label: "Email", fillText: "ada@example.test" },
    });
    expect(parse(["fill", "@e3", "hi"])).toMatchObject({ command: "fill", args: { ref: "@e3", fillText: "hi" } });
    expect(parse(["text", "--role", "main"])).toMatchObject({ command: "text", args: { role: "main" } });
    expect(parse(["wait", "--text", "Done", "--gone"])).toMatchObject({
      command: "wait",
      args: { text: "Done", gone: true },
    });
    expect(errorCodeOf(() => parse(["wait", "--ref", "e1"]))).toBe("bad_args");
  });

  it("makes --out absolute and refuses it with --inline", () => {
    expect(parse(["eval", "1", "--out", "v.json"])).toMatchObject({
      args: { out: `${process.cwd()}/v.json`, inline: false },
    });
    expect(parse(["network", "get", "--url", "*/api/*", "--body", "--inline"])).toMatchObject({
      command: "network-get",
      args: { id: undefined, url: "*/api/*", body: true, inline: true },
    });
    expect(errorCodeOf(() => parse(["text", "--out", "a.txt", "--inline"]))).toBe("bad_args");
    expect(errorCodeOf(() => parse(["network", "get"]))).toBe("bad_args");
  });

  it("handles session history and pipe locally", () => {
    expect(parse(["session", "history", "--format", "jsonl"])).toEqual({
      kind: "history",
      profile: "stealth",
      session: "fallback-session",
      format: "jsonl",
      out: undefined,
      isClear: false,
      isJson: false,
    });
    expect(parse(["--session", "s", "session", "history", "clear"])).toMatchObject({
      kind: "history",
      session: "s",
      isClear: true,
    });
    expect(errorCodeOf(() => parse(["session", "history", "--format", "py"]))).toBe("bad_args");
    expect(parse(["pipe", "--bail"])).toEqual({
      kind: "pipe",
      profile: "stealth",
      session: "fallback-session",
      isBail: true,
    });
  });
});
