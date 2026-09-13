import { describe, expect, it } from "vitest";
import { isInterstitialTitle, vendorOfFrameUrl } from "../../src/challenges.ts";
import { parseCli } from "../../src/cli.ts";
import { parseTarget } from "../../src/targets.ts";

describe("parseTarget", () => {
  it("takes exactly one of ref, locator or point", () => {
    expect(parseTarget({ ref: "@e3" }, { allowsPoint: true })).toEqual({ kind: "ref", ref: "@e3" });
    expect(parseTarget({ selector: "#cb", frame: "iframe" }, { allowsPoint: true })).toEqual({
      kind: "selector",
      selector: "#cb",
      frame: "iframe",
      nth: undefined,
    });
    expect(parseTarget({ at: "120,34.5" }, { allowsPoint: true })).toEqual({ kind: "point", x: 120, y: 34.5 });
    expect(() => parseTarget({}, { allowsPoint: true })).toThrow("no target given");
    expect(() => parseTarget({ ref: "@e3", at: "1,1" }, { allowsPoint: true })).toThrow("give one target");
    expect(() => parseTarget({ ref: "@e3", frame: "iframe" }, { allowsPoint: true })).toThrow(
      "--frame goes with --role, --text, --label or --selector",
    );
    expect(() => parseTarget({ at: "1,1" }, { allowsPoint: false })).toThrow("--at works with click only");
    expect(() => parseTarget({ at: "1;1" }, { allowsPoint: true })).toThrow("--at takes <x>,<y>");
  });

  it("reads role, text and label locators with --name, --exact, --nth and --frame", () => {
    expect(parseTarget({ role: "button", name: "Sign in", exact: true, nth: "1" }, { allowsPoint: false })).toEqual({
      kind: "role",
      role: "button",
      name: "Sign in",
      isExact: true,
      frame: undefined,
      nth: 1,
    });
    expect(parseTarget({ role: "link" }, { allowsPoint: false })).toEqual({
      kind: "role",
      role: "link",
      name: undefined,
      isExact: false,
      frame: undefined,
      nth: undefined,
    });
    expect(parseTarget({ text: "More", frame: "iframe" }, { allowsPoint: false })).toEqual({
      kind: "text",
      text: "More",
      isExact: false,
      frame: "iframe",
      nth: undefined,
    });
    expect(parseTarget({ label: "Email", exact: true }, { allowsPoint: false })).toEqual({
      kind: "label",
      label: "Email",
      isExact: true,
      frame: undefined,
      nth: undefined,
    });
    expect(() => parseTarget({ role: "buton" }, { allowsPoint: false })).toThrow("--role buton is not an ARIA role");
    expect(() => parseTarget({ text: "a", name: "b" }, { allowsPoint: false })).toThrow("--name goes with --role");
    expect(() => parseTarget({ selector: "a", exact: true }, { allowsPoint: false })).toThrow("--exact goes with");
    expect(() => parseTarget({ role: "button", nth: "-1" }, { allowsPoint: false })).toThrow(
      "--nth must be a whole number",
    );
    expect(() => parseTarget({ role: "button", text: "a" }, { allowsPoint: false })).toThrow("give one target");
    expect(() => parseTarget({ ref: "e1", nth: "2" }, { allowsPoint: false })).toThrow("--nth goes with");
  });
});

describe("challenge vendors", () => {
  it("names widget frames by host and path", () => {
    expect(vendorOfFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2")).toBe(
      "turnstile",
    );
    expect(vendorOfFrameUrl("https://www.google.com/recaptcha/api2/anchor?k=x")).toBe("recaptcha");
    expect(vendorOfFrameUrl("https://www.recaptcha.net/recaptcha/api2/bframe")).toBe("recaptcha");
    expect(vendorOfFrameUrl("https://www.google.com/maps/embed")).toBeUndefined();
    expect(vendorOfFrameUrl("https://newassets.hcaptcha.com/captcha/v1/x")).toBe("hcaptcha");
    expect(vendorOfFrameUrl("https://geo.captcha-delivery.com/captcha/?x")).toBe("datadome");
    expect(vendorOfFrameUrl("https://notcloudflare.com.evil.test/")).toBeUndefined();
    expect(vendorOfFrameUrl("https://service.mtcaptcha.com/mtcv1/client/iframe.html?sitekey=x")).toBe("mtcaptcha");
    expect(vendorOfFrameUrl("about:blank")).toBeUndefined();
  });

  it("recognises Cloudflare's full-page check by title", () => {
    expect(isInterstitialTitle("Just a moment...")).toBe(true);
    expect(isInterstitialTitle("Just a moment about cats")).toBe(false);
  });
});

describe("cli targets", () => {
  const parse = (argv: string[]) => parseCli(argv, {}, () => "s");
  it("reads fill's only positional as text when --selector is given", () => {
    expect(parse(["fill", "--selector", "#code", "--frame", "iframe", "ab1"])).toMatchObject({
      command: "fill",
      args: { selector: "#code", frame: "iframe", fillText: "ab1" },
    });
    expect(parse(["fill", "@e2", "hi"])).toMatchObject({ command: "fill", args: { ref: "@e2", fillText: "hi" } });
    expect(parse(["click", "--at", "5,6"])).toMatchObject({ command: "click", args: { at: "5,6" } });
  });

  it("gives a person ten minutes on a challenge handoff", () => {
    expect(parse(["challenge", "--handoff"])).toMatchObject({
      command: "challenge",
      timeoutMs: 600_000,
      args: { handoff: true },
    });
    expect(parse(["challenge"])).toMatchObject({ timeoutMs: 30_000 });
  });
});
