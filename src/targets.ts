import type { Locator, Page } from "patchright";
import { CommandError, type CommandArgs } from "./protocol.ts";

// Roles Playwright's getByRole accepts, which are also the roles a snapshot line starts with.
export const ariaRoles = ["alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem"] as const;
export type AriaRole = (typeof ariaRoles)[number];

export function isAriaRole(value: string): value is AriaRole {
  return (ariaRoles as readonly string[]).includes(value);
}

// Where a locator looks and which of its matches it takes. Without nth a locator takes the first match.
export interface LocatorScope {
  frame: string | undefined;
  nth: number | undefined;
}

// An element found again on every run. A ref is only good until the page changes, so a script names
// elements by selector, role and accessible name, visible text, or form label instead.
export type ElementLocator =
  | ({ kind: "selector"; selector: string } & LocatorScope)
  | ({ kind: "role"; role: AriaRole; name: string | undefined; isExact: boolean } & LocatorScope)
  | ({ kind: "text"; text: string; isExact: boolean } & LocatorScope)
  | ({ kind: "label"; label: string; isExact: boolean } & LocatorScope);

// What an act aims at. A ref comes from the latest snapshot. A selector reaches what a snapshot cannot
// show: Patchright's CSS engine pierces closed shadow roots, which hide a widget's whole subtree from the
// accessibility tree. A point is viewport CSS pixels, read off a screenshot, for canvas and anything else
// without an element to name. All of them end in trusted input events.
export type Target =
  | { kind: "ref"; ref: string }
  | ElementLocator
  | { kind: "point"; x: number; y: number };

const targetHint = "pass a ref from the latest snapshot, --role <role> [--name <name>], --text <text>, --label <text>, --selector <css>, or --at <x>,<y>";
const locatorKinds = ["selector", "role", "text", "label"] as const;

export function parseTarget(args: CommandArgs, { allowsPoint }: { allowsPoint: boolean }): Target {
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const at = typeof args.at === "string" ? args.at : undefined;
  const locatorNames = locatorKinds.filter((name) => typeof args[name] === "string");
  const given = [ref, at].filter((value) => value !== undefined).length + locatorNames.length;
  if (given !== 1) throw new CommandError("bad_args", given === 0 ? "no target given" : "give one target, not several", targetHint);
  if (ref !== undefined || at !== undefined) {
    const stray = (["frame", "nth", "name"] as const).find((name) => args[name] !== undefined) ?? (args.exact === true ? "exact" : undefined);
    if (stray !== undefined) throw new CommandError("bad_args", `--${stray} goes with --role, --text, --label or --selector`, targetHint);
  }
  if (ref !== undefined) return { kind: "ref", ref };
  if (at === undefined) return parseElementLocator(args, targetHint) ?? unreachable();
  if (!allowsPoint) throw new CommandError("bad_args", "--at works with click only", "click the field with --at first, then run `patchrome type <text>`");
  const match = at.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  if (!match?.[1] || !match[2]) throw new CommandError("bad_args", `--at takes <x>,<y> in viewport pixels, got ${at}`, "for example --at 120,340");
  return { kind: "point", x: Number(match[1]), y: Number(match[2]) };
}

// Reads one of --selector, --role, --text, --label with --name, --exact, --nth and --frame. Undefined when
// none is given; wait also takes --url, --title and --load, so absence is not an error here.
export function parseElementLocator(args: CommandArgs, hint: string): ElementLocator | undefined {
  const given = locatorKinds.filter((name) => typeof args[name] === "string");
  const [kind] = given;
  const name = typeof args.name === "string" ? args.name : undefined;
  const isExact = args.exact === true;
  const frame = typeof args.frame === "string" ? args.frame : undefined;
  if (kind === undefined) {
    const stray = frame !== undefined ? "frame" : name !== undefined ? "name" : args.nth !== undefined ? "nth" : isExact ? "exact" : undefined;
    if (stray !== undefined) throw new CommandError("bad_args", `--${stray} goes with --role, --text, --label or --selector`, hint);
    return undefined;
  }
  if (given.length > 1) throw new CommandError("bad_args", `give one of ${given.map((option) => `--${option}`).join(" ")}, not several`, hint);
  const value = String(args[kind]);
  if (value === "" || frame === "") throw new CommandError("bad_args", `--${kind}${frame === "" ? " and --frame" : ""} need a non-empty value`, hint);
  if (name !== undefined && kind !== "role") throw new CommandError("bad_args", "--name goes with --role", "for example --role button --name 'Sign in'");
  if (isExact && (kind === "selector" || (kind === "role" && name === undefined))) throw new CommandError("bad_args", "--exact goes with --name, --text or --label", hint);
  const scope: LocatorScope = { frame, nth: parseNth(args.nth) };
  switch (kind) {
    case "selector":
      return { kind, selector: value, ...scope };
    case "role":
      if (!isAriaRole(value)) throw new CommandError("bad_args", `--role ${value} is not an ARIA role`, `roles: ${ariaRoles.join(" ")}`);
      return { kind, role: value, name, isExact, ...scope };
    case "text":
      return { kind, text: value, isExact, ...scope };
    case "label":
      return { kind, label: value, isExact, ...scope };
  }
}

function parseNth(raw: CommandArgs[string]): number | undefined {
  if (raw === undefined) return undefined;
  const nth = Number(raw);
  if (!Number.isInteger(nth) || nth < 0) throw new CommandError("bad_args", `--nth must be a whole number from 0, got ${String(raw)}`);
  return nth;
}

function unreachable(): never {
  throw new CommandError("bad_args", "no target given", targetHint);
}

export function elementLocator(page: Page, target: ElementLocator): Locator {
  const root = target.frame === undefined ? page : page.frameLocator(target.frame);
  const matches = (() => {
    switch (target.kind) {
      case "selector":
        return root.locator(target.selector);
      case "role":
        return root.getByRole(target.role, target.name === undefined ? {} : { name: target.name, exact: target.isExact });
      case "text":
        return root.getByText(target.text, { exact: target.isExact });
      case "label":
        return root.getByLabel(target.label, { exact: target.isExact });
    }
  })();
  return target.nth === undefined ? matches.first() : matches.nth(target.nth);
}

export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "ref":
      return target.ref;
    case "point":
      return `${target.x},${target.y}`;
    case "selector":
    case "role":
    case "text":
    case "label":
      return describeElementLocator(target);
  }
}

export function describeElementLocator(target: ElementLocator): string {
  const what = (() => {
    switch (target.kind) {
      case "selector":
        return target.selector;
      case "role":
        return target.name === undefined ? target.role : `${target.role} "${target.name}"`;
      case "text":
        return `text "${target.text}"`;
      case "label":
        return `label "${target.label}"`;
    }
  })();
  return `${what}${target.nth === undefined ? "" : ` #${target.nth}`}${target.frame === undefined ? "" : ` in ${target.frame}`}`;
}

// A person's pointer travels to the spot, and their keys land tens of milliseconds apart.
export async function clickPoint(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.click(x, y, { delay: jitterMs(40, 110) });
}

export async function typeLikeAPerson(page: Page, text: string): Promise<void> {
  for (const character of text) {
    await page.keyboard.type(character);
    await new Promise((resolve) => setTimeout(resolve, jitterMs(45, 140)));
  }
}

function jitterMs(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}
