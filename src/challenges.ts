import type { Frame, Page } from "patchright";
import { CommandError } from "./protocol.ts";

export const challengeVendors = [
  "turnstile",
  "recaptcha",
  "hcaptcha",
  "datadome",
  "mtcaptcha",
  "cloudflare-interstitial",
  "unknown",
] as const;
export type ChallengeVendor = (typeof challengeVendors)[number];

export interface ChallengeWidget {
  vendor: ChallengeVendor;
  url: string;
  // Page viewport CSS pixels of the widget's iframe, when it has one on screen.
  box: { x: number; y: number; width: number; height: number } | undefined;
}

export type ChallengeState = "none" | "pending" | "solved";

export interface ChallengeReport {
  state: ChallengeState;
  widgets: ChallengeWidget[];
}

// Widgets write their pass token into a form field of the host page; a filled field means the check passed.
const tokenFieldSelector = [
  '[name="cf-turnstile-response"]',
  '[name="g-recaptcha-response"]',
  '[name="h-captcha-response"]',
  '[name="mtcaptcha-verifiedtoken"]',
].join(", ");
const handoffPollMs = 500;

export function vendorOfFrameUrl(url: string): ChallengeVendor | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host === "challenges.cloudflare.com") return "turnstile";
  if ((host === "www.google.com" || host === "www.recaptcha.net") && parsed.pathname.startsWith("/recaptcha/"))
    return "recaptcha";
  if (host === "hcaptcha.com" || host.endsWith(".hcaptcha.com")) return "hcaptcha";
  if (host.endsWith(".captcha-delivery.com")) return "datadome";
  if (host === "service.mtcaptcha.com") return "mtcaptcha";
  return undefined;
}

// Cloudflare's full-page check shows this title until it lets the visitor through.
export function isInterstitialTitle(title: string): boolean {
  return /^just a moment\.*$/i.test(title.trim());
}

export async function inspectChallenges(page: Page): Promise<ChallengeReport> {
  const widgets: ChallengeWidget[] = [];
  // The main frame is the site itself, even on a vendor's own demo page.
  for (const frame of page.frames().filter((candidate) => candidate !== page.mainFrame())) {
    const vendor = vendorOfFrameUrl(frame.url());
    if (vendor === undefined) continue;
    widgets.push({ vendor, url: frame.url(), box: await frameBox(frame) });
  }
  const title = await page.title().catch(() => "");
  if (isInterstitialTitle(title)) widgets.push({ vendor: "cloudflare-interstitial", url: page.url(), box: undefined });

  const tokens = await tokenValues(page);
  if (widgets.length === 0 && tokens.length > 0) widgets.push({ vendor: "unknown", url: page.url(), box: undefined });
  const isSolved = tokens.some((token) => token !== "");
  const state: ChallengeState = widgets.length === 0 ? "none" : isSolved ? "solved" : "pending";
  return { state, widgets };
}

// Raises the tab for a person to solve, then returns once the widget passes, the page moves past it, or the
// person closes the tab.
export async function waitForPersonToSolve(page: Page, timeoutMs: number): Promise<ChallengeReport> {
  await page.bringToFront();
  const deadlineMs = Date.now() + timeoutMs;
  for (;;) {
    if (page.isClosed())
      throw new CommandError(
        "tab_gone",
        "the tab closed before the challenge was solved",
        "run `patchrome open <url>`",
      );
    const report = await inspectChallenges(page).catch(() => undefined);
    if (report !== undefined && report.state !== "pending") return report;
    if (Date.now() >= deadlineMs)
      throw new CommandError(
        "timeout",
        `the challenge was not solved within ${timeoutMs} ms`,
        "raise --timeout-ms, or check the tab with screenshot",
      );
    await new Promise((resolve) => setTimeout(resolve, handoffPollMs));
  }
}

async function frameBox(frame: Frame): Promise<ChallengeWidget["box"]> {
  const element = await frame.frameElement().catch(() => undefined);
  const box = await element?.boundingBox().catch(() => null);
  return box ?? undefined;
}

async function tokenValues(page: Page): Promise<string[]> {
  const values: string[] = [];
  for (const frame of page.frames()) {
    const fields = frame.locator(tokenFieldSelector);
    const count = await fields.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      values.push(
        await fields
          .nth(index)
          .inputValue({ timeout: 1000 })
          .catch(() => ""),
      );
    }
  }
  return values;
}
