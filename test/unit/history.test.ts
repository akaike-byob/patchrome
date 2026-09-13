import { describe, expect, it } from "vitest";
import { formatHistory, locatorForRef, replayStep, requestUrlGlob, shellWord, stepArgv } from "../../src/history.ts";

const snapshot = `- generic [ref=e1]:
  - heading "Shop" [level=1] [ref=e2]
  - textbox "Email" [ref=e3]
  - textbox [ref=e4]
  - button "Add to cart" [ref=e5] [cursor=pointer]
  - button "Add to cart" [ref=e6] [cursor=pointer]
  - link "Say \\"hi\\"" [ref=e7]
  - iframe [ref=e8]:
    - checkbox "Verify" [ref=f1e2]`;

describe("locatorForRef", () => {
  it("turns a unique role and name into an exact locator", () => {
    expect(locatorForRef(snapshot, "e3")).toEqual({ flags: ["--role", "textbox", "--name", "Email", "--exact"], notes: [] });
    expect(locatorForRef(snapshot, "e7")?.flags).toEqual(["--role", "link", "--name", 'Say "hi"', "--exact"]);
  });

  it("adds --nth for repeated and nameless nodes, with a note", () => {
    expect(locatorForRef(snapshot, "e6")).toEqual({ flags: ["--role", "button", "--name", "Add to cart", "--exact", "--nth", "1"], notes: [expect.stringContaining("2 elements matched")] });
    expect(locatorForRef(snapshot, "e4")?.flags).toEqual(["--role", "textbox", "--nth", "1"]);
  });

  it("treats the root's frame prefix as the page", () => {
    const prefixed = '- generic [ref=f1e1]:\n  - button "Go" [ref=f1e2]\n  - iframe [ref=f1e3]:\n    - button "Go" [ref=f2e1]';
    expect(locatorForRef(prefixed, "f1e2")).toEqual({ flags: ["--role", "button", "--name", "Go", "--exact"], notes: [] });
    expect(locatorForRef(prefixed, "f2e1")?.notes).toEqual([expect.stringContaining("--frame")]);
  });

  it("notes refs inside iframes and returns undefined for unknown refs", () => {
    expect(locatorForRef(snapshot, "f1e2")).toEqual({ flags: ["--role", "checkbox", "--name", "Verify", "--exact"], notes: [expect.stringContaining("--frame")] });
    expect(locatorForRef(snapshot, "e99")).toBeUndefined();
  });
});

describe("replayStep", () => {
  it("drops caller flags and replaces a positional ref", () => {
    const step = replayStep("click", ["--json", "--session", "s1", "click", "@e5"], { refLocator: { flags: ["--role", "button"], notes: ["n"] } }, 5);
    expect(step).toEqual({ atMs: 5, argv: ["click", "--role", "button"], notes: ["n"] });
  });

  it("replaces --ref with its value, request ids and secret text", () => {
    expect(replayStep("text", ["text", "--ref", "e2", "--inline"], { refLocator: { flags: ["--role", "heading"], notes: [] } }, 0).argv).toEqual(["text", "--role", "heading", "--inline"]);
    expect(replayStep("text", ["text", "--ref=e2"], { refLocator: { flags: ["--role", "heading"], notes: [] } }, 0).argv).toEqual(["text", "--role", "heading"]);
    expect(replayStep("network-get", ["network", "get", "n17", "--body"], { requestUrlGlob: "https://a.test/api*" }, 0).argv).toEqual(["network", "get", "--url", "https://a.test/api*", "--body"]);
    const secret = replayStep("fill", ["fill", "@e3", "hunter2"], { refLocator: { flags: ["--label", "Password"], notes: [] }, isSecretText: true }, 0);
    expect(secret.argv).toEqual(["fill", "--label", "Password", "<secret>"]);
    expect(secret.notes[0]).toContain("password");
  });

  it("keeps words it has no hint for, and notes tab ids", () => {
    expect(stepArgv(["--profile", "debug", "--timeout-ms", "900", "goto", "https://a.test"])).toEqual(["--timeout-ms", "900", "goto", "https://a.test"]);
    expect(replayStep("switch", ["switch", "t3"], undefined, 0).notes).toEqual(["tab ids from the recording can differ on replay"]);
  });
});

describe("formatHistory", () => {
  const steps = [
    { atMs: Date.UTC(2026, 8, 13, 10), argv: ["open", "https://a.test/?q=a b"], notes: [] },
    { atMs: Date.UTC(2026, 8, 13, 11), argv: ["fill", "--label", "Password", "<secret>"], notes: ["password"] },
  ];

  it("writes a runnable sh script with notes as check comments", () => {
    expect(formatHistory(steps, "sh", { session: "s1", profile: "debug" })).toBe([
      "#!/bin/sh",
      "# patchrome session s1: 2 steps, 2026-09-13T10:00:00.000Z to 2026-09-13T11:00:00.000Z",
      "# Lines starting with `# check:` need a look before this runs unattended.",
      "set -eu",
      'export PATCHROME_SESSION="${PATCHROME_SESSION:-replay-$$}"',
      'export PATCHROME_PROFILE="${PATCHROME_PROFILE:-debug}"',
      "",
      "patchrome open 'https://a.test/?q=a b'",
      "# check: password",
      'patchrome fill --label Password "$PATCHROME_SECRET"',
      "patchrome session close",
    ].join("\n"));
  });

  it("writes pipe requests as jsonl", () => {
    expect(formatHistory(steps, "jsonl", { session: "s1", profile: "stealth" }).split("\n")).toEqual([
      '{"argv":["open","https://a.test/?q=a b"]}',
      '{"argv":["fill","--label","Password","<secret>"],"notes":["password"]}',
    ]);
  });

  it("quotes shell words and globs request URLs", () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
    expect(shellWord("--role")).toBe("--role");
    expect(requestUrlGlob("https://a.test/api/items?page=2")).toBe("https://a.test/api/items*");
    expect(requestUrlGlob("https://a.test/a*b")).toBe("https://a.test/a?b*");
  });
});
