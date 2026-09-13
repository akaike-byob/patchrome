import type { Page } from "patchright";
import { urlGlobMatches } from "./glob.ts";
import { CommandError, type CommandArgs } from "./protocol.ts";
import { describeElementLocator, elementLocator, parseElementLocator, type ElementLocator } from "./targets.ts";

export const loadStates = ["load", "domcontentloaded", "networkidle"] as const;
export type LoadState = (typeof loadStates)[number];

// Each condition reads what the page shows now, so a change that happened before `wait` started still
// counts. `--gone` flips it: wait for the challenge title or the spinner to go away.
export type WaitCondition =
  | { kind: "element"; locator: ElementLocator; isGone: boolean }
  | { kind: "url"; glob: string; isGone: boolean }
  | { kind: "title"; text: string; isGone: boolean }
  | { kind: "load"; state: LoadState };

const titlePollMs = 250;
const waitHint =
  "wait --selector <css> | --role <role> [--name <name>] | --text <text> | --label <text> | --url <glob> | --title <text> [--gone], or wait --load load|domcontentloaded|networkidle";

export function parseWaitCondition(args: CommandArgs): WaitCondition {
  const isGone = args.gone === true;
  const pageConditions = (["url", "title", "load"] as const).filter((name) => typeof args[name] === "string");
  const elementConditions = (["selector", "role", "text", "label"] as const).filter(
    (name) => typeof args[name] === "string",
  );
  const given = [...elementConditions, ...pageConditions];
  if (given.length !== 1) {
    throw new CommandError(
      "bad_args",
      given.length === 0
        ? "wait needs a condition"
        : `wait takes one condition, got ${given.map((option) => `--${option}`).join(" ")}`,
      waitHint,
    );
  }
  const locator = parseElementLocator(args, waitHint);
  if (locator !== undefined) return { kind: "element", locator, isGone };
  const [name] = pageConditions;
  if (name === undefined) throw new CommandError("bad_args", "wait needs a condition", waitHint);
  const value = String(args[name]);
  if (value === "") throw new CommandError("bad_args", `wait --${name} needs a non-empty value`);
  switch (name) {
    case "url":
      return { kind: "url", glob: value, isGone };
    case "title":
      return { kind: "title", text: value, isGone };
    case "load":
      if (isGone) throw new CommandError("bad_args", "wait --load does not take --gone");
      if (!(loadStates as readonly string[]).includes(value))
        throw new CommandError("bad_args", `wait --load must be one of ${loadStates.join(", ")}, got ${value}`);
      return { kind: "load", state: value as LoadState };
  }
}

export function describeWaitCondition(condition: WaitCondition): string {
  switch (condition.kind) {
    case "element":
      return `${condition.isGone ? "no visible" : "a visible"} ${describeElementLocator(condition.locator)}`;
    case "url":
      return `url ${condition.isGone ? "leaving" : "matching"} ${condition.glob}`;
    case "title":
      return `title ${condition.isGone ? "without" : "with"} "${condition.text}"`;
    case "load":
      return `load state ${condition.state}`;
  }
}

// Element and URL conditions use Patchright's own waits, which query from an isolated world: a probe page that
// wrapped querySelector, getClientRects and requestAnimationFrame saw no calls from them. waitForFunction
// does run in the page's realm (the probe saw its requestAnimationFrame polling), so the title is polled
// from here instead. Throws Playwright's TimeoutError when the time runs out.
export async function waitForCondition(page: Page, condition: WaitCondition, timeoutMs: number): Promise<void> {
  switch (condition.kind) {
    case "load":
      return page.waitForLoadState(condition.state, { timeout: timeoutMs });
    case "element": {
      const locator = elementLocator(page, condition.locator);
      // On a macOS CI runner waitFor took over a second to report an element that was already visible.
      // One direct read answers that case at once; a bad locator falls through so waitFor reports it.
      const isVisible = await locator.isVisible().catch(() => undefined);
      if (isVisible !== undefined && isVisible !== condition.isGone) return;
      return locator.waitFor({
        state: condition.isGone ? "hidden" : "visible",
        timeout: timeoutMs,
      });
    }
    case "url":
      await page.waitForURL((url) => urlGlobMatches(condition.glob, url.href) !== condition.isGone, {
        timeout: timeoutMs,
        waitUntil: "commit",
      });
      return;
    case "title": {
      const deadlineMs = Date.now() + timeoutMs;
      // A read that lands mid-navigation throws; it counts as not yet.
      while (
        (await page.title().then(
          (title) => title.includes(condition.text),
          () => condition.isGone,
        )) === condition.isGone
      ) {
        if (Date.now() >= deadlineMs)
          throw new CommandError("timeout", `no ${describeWaitCondition(condition)} within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, titlePollMs));
      }
      return;
    }
  }
}
