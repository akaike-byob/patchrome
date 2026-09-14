import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Cookie, Locator, Page } from "patchright";
import { inspectChallenges, waitForPersonToSolve } from "./challenges.ts";
import {
  copySiteLoginStorage,
  describeChromeProfile,
  hostBelongsToSite,
  isGoogleHost,
  listChromeProfiles,
  resolveChromeProfile,
  siteFromInput,
  siteStorageOrigins,
} from "./chrome-profiles.ts";
import {
  parseWatchEventKinds,
  urlOfEvent,
  watchEventFields,
  watchEventLine,
  type SessionEvents,
  type WatchEvent,
} from "./events.ts";
import type { CopyGuard } from "./copy-guard.ts";
import { consoleLine, isAtLeast, parseConsoleLevel, type PageDiagnostics } from "./diagnostics.ts";
import type { BrowserEngine } from "./engine.ts";
import { extractRowsInPage, parseExtractSchema } from "./extract.ts";
import { isNamePattern, nameGlobMatches, urlGlobMatches } from "./glob.ts";
import { buildHar, type HarBody } from "./har.ts";
import { bodyExtension, isTextual, type NetworkEntry, type NetworkLog } from "./network.ts";
import {
  fromStorageStateIndexedDb,
  readOriginStorageInPage,
  toStorageStateIndexedDb,
  writeOriginStorageInPage,
  type OriginStorage,
  type StorageStateIndexedDb,
} from "./origin-storage.ts";
import { sessionFolderName } from "./paths.ts";
import type { ProfileMode } from "./profile-mode.ts";
import {
  CommandError,
  type CommandArgs,
  type CommandData,
  type CommandName,
  type DaemonStreamLine,
} from "./protocol.ts";
import { parseProtocolSchema, protocolHelp } from "./protocol-help.ts";
import { locatorForRef, requestUrlGlob, type ReplayHint } from "./history.ts";
import { parseRef, refsIn } from "./refs.ts";
import type { RouteRule, RouteTable } from "./routes.ts";
import { z } from "zod";
import { parseJsonInput } from "./validate.ts";
import type { SavedSession, SessionRegistry, Tab } from "./sessions.ts";
import { clickPoint, describeTarget, elementLocator, parseTarget, typeLikeAPerson, type Target } from "./targets.ts";
import { describeWaitCondition, parseWaitCondition, waitForCondition } from "./wait.ts";

// Output past this size goes to a file in the session folder, and stdout carries the path.
const inlineLimitBytes = 2048;

const waitStates = ["load", "domcontentloaded", "networkidle"] as const;
type WaitState = (typeof waitStates)[number];

export interface CommandContext {
  engine: BrowserEngine;
  registry: SessionRegistry;
  network: NetworkLog;
  routes: RouteTable;
  diagnostics: PageDiagnostics;
  events: SessionEvents;
  mode: ProfileMode;
  // Playwright traces a whole browser context, so one session at a time owns the recording.
  trace: { owner: string | undefined };
  consoleCaptureReady: (tab: Tab) => Promise<void>;
  version: string;
  buildId: string;
  sessionsDir: string;
  // The Chrome user data dir the daemon launched, read by state export to find which origins hold storage.
  profile: string;
  startedAtMs: number;
  requestShutdown: () => void;
  // Regroups the session's tabs under its current title; resolves once every queued regroup has run.
  regroupTabs: (session: string) => Promise<void>;
  // Sessions saved before a daemon restart that no command has reopened yet.
  savedSessionNames: () => string[];
  forgetSavedSession: (session: string) => void;
  copyGuard: CopyGuard;
}

export interface CommandCall {
  session: string;
  command: CommandName;
  args: CommandArgs;
  timeoutMs: number;
  emit: (stream: DaemonStreamLine["stream"]) => void;
  disconnected: AbortSignal;
}

export async function runCommand(ctx: CommandContext, call: CommandCall): Promise<CommandData> {
  const { session, args, timeoutMs } = call;
  switch (call.command) {
    case "open": {
      const browserContextId = await browserContextForOpen(ctx, session, args.isolated === true);
      const page = await ctx.engine.openBackgroundPage(browserContextId);
      const tab = ctx.registry.adoptPage(session, page, true);
      await ctx.consoleCaptureReady(tab);
      const url = optionalString(args, "url");
      if (url !== undefined) {
        try {
          await navigate(page, url, waitStateArg(args), timeoutMs);
        } catch (err) {
          // A failed open leaves no blank tab behind, so retries do not pile up orphans.
          await page.close().catch(() => {});
          throw err;
        }
      }
      return describeTab(tab, `opened ${tab.id}`);
    }
    case "tabs": {
      const tabs = args.all === true ? ctx.registry.allTabs() : ctx.registry.tabsOf(session);
      const lines =
        tabs.length === 0
          ? ["no tabs"]
          : tabs.map(
              (tab) =>
                `${tab.isCurrent ? "*" : " "} ${tab.id}${args.all === true ? ` [${tab.session}]` : ""} ${tab.url}`,
            );
      return { lines, fields: { tabs } };
    }
    case "switch": {
      const tab = ctx.registry.switchTo(session, requiredString(args, "tab"));
      return describeTab(tab, `switched to ${tab.id}`);
    }
    case "close": {
      const tabId = optionalString(args, "tab");
      const tab = tabId === undefined ? ctx.registry.currentTab(session) : ctx.registry.ownedTab(session, tabId);
      await tab.page.close();
      return { lines: [`closed ${tab.id}`], fields: { tab: tab.id } };
    }
    case "goto": {
      const tab = ctx.registry.currentTab(session);
      await navigate(tab.page, requiredString(args, "url"), waitStateArg(args), timeoutMs);
      return describeTab(tab, `navigated ${tab.id}`);
    }
    case "snapshot": {
      const tab = ctx.registry.currentTab(session);
      // The page-level snapshot descends into iframes, cross-site ones included, and prefixes their refs.
      const snapshot = await guardTab(tab, () => tab.page.ariaSnapshot({ mode: "ai", timeout: timeoutMs }));
      tab.generations.recordSnapshot(snapshot);
      const refCount = refsIn(snapshot).size;
      const title = await tab.page.title();
      const page = { url: tab.page.url(), title, refCount };
      const pageLines = [`url: ${page.url}`, `title: ${title}`, `refs: ${refCount}`];
      if (args.inline === true) return { lines: [...pageLines, snapshot], fields: { ...page, snapshot } };
      const path = await outputPath(ctx, session, args, `snapshot-${tab.id}`, "yml");
      await writeFile(path, snapshot);
      return { lines: [`snapshot: ${path}`, ...pageLines], fields: { path, ...page } };
    }
    case "click": {
      const tab = ctx.registry.currentTab(session);
      const target = parseTarget(args, { allowsPoint: true });
      if (target.kind === "point") {
        await guardTab(tab, () => clickPoint(tab.page, target.x, target.y));
      } else {
        await guardTab(tab, () => targetLocator(tab, target).click({ timeout: timeoutMs }));
      }
      return { ...(await describeTab(tab, `clicked ${describeTarget(target)}`)), replay: refReplay(tab, target) };
    }
    case "fill": {
      const tab = ctx.registry.currentTab(session);
      const target = parseTarget(args, { allowsPoint: false });
      if (target.kind === "point") throw new CommandError("bad_args", "fill needs a ref or a locator");
      const locator = targetLocator(tab, target);
      await guardTab(tab, () => locator.fill(requiredString(args, "fillText"), { timeout: timeoutMs }));
      const isSecretText = await locator
        .evaluate(
          (element) => element instanceof HTMLInputElement && element.type === "password",
          undefined,
          { timeout: timeoutMs },
          true,
        )
        .catch(() => false);
      return {
        ...(await describeTab(tab, `filled ${describeTarget(target)}`)),
        replay: { ...refReplay(tab, target), isSecretText },
      };
    }
    case "type": {
      const tab = ctx.registry.currentTab(session);
      const text = requiredString(args, "text");
      const isSecretText = await tab.page
        .evaluate(
          () => document.activeElement instanceof HTMLInputElement && document.activeElement.type === "password",
          undefined,
          undefined,
          true,
        )
        .catch(() => false);
      await guardTab(tab, () => typeLikeAPerson(tab.page, text));
      return { ...(await describeTab(tab, `typed ${text.length} characters`)), replay: { isSecretText } };
    }
    case "challenge": {
      const tab = ctx.registry.currentTab(session);
      const report = await guardTab(tab, () =>
        args.handoff === true ? waitForPersonToSolve(tab.page, timeoutMs) : inspectChallenges(tab.page),
      );
      const widgetLines = report.widgets.map(
        (widget) =>
          `${widget.vendor} ${widget.box === undefined ? "" : `at ${Math.round(widget.box.x)},${Math.round(widget.box.y)} ${Math.round(widget.box.width)}x${Math.round(widget.box.height)} `}${widget.url}`,
      );
      return {
        lines: [`challenge: ${report.state}`, ...widgetLines],
        fields: { tab: tab.id, state: report.state, widgets: report.widgets },
      };
    }
    case "press": {
      const tab = ctx.registry.currentTab(session);
      await guardTab(tab, () => tab.page.keyboard.press(requiredString(args, "key")));
      return describeTab(tab, `pressed ${args.key}`);
    }
    case "screenshot": {
      const tab = ctx.registry.currentTab(session);
      const element = optionalElement(tab, args);
      const image = await guardTab(tab, () =>
        element === undefined
          ? tab.page.screenshot({ fullPage: args.full === true, timeout: timeoutMs })
          : element.screenshot({ timeout: timeoutMs }),
      );
      const path = await outputPath(ctx, session, args, `screenshot-${tab.id}`, "png");
      await writeFile(path, image);
      return {
        lines: [`screenshot: ${path}`, `url: ${tab.page.url()}`],
        fields: { path, url: tab.page.url() },
        replay: optionalRefReplay(tab, args),
      };
    }
    case "text": {
      const tab = ctx.registry.currentTab(session);
      const locator = optionalElement(tab, args) ?? tab.page.locator("body");
      const text = await guardTab(tab, () => locator.innerText({ timeout: timeoutMs }));
      return {
        ...(await deliver(ctx, session, args, {
          field: "text",
          value: text,
          content: text,
          prefix: `text-${tab.id}`,
          extension: "txt",
        })),
        replay: optionalRefReplay(tab, args),
      };
    }
    case "eval": {
      const tab = ctx.registry.currentTab(session);
      const expression = requiredString(args, "js");
      const isMainWorld = args.mainWorld === true;
      // Patchright's 4th evaluate argument picks the world; the isolated world hides page globals but
      // leaves no trace in the page's own JS realm.
      // oxlint-disable-next-line typescript/unbound-method -- called with tab.page as this on the next line
      const evaluate = tab.page.evaluate as unknown as (
        fn: string,
        arg: undefined,
        options: undefined,
        isolatedContext: boolean,
      ) => Promise<unknown>;
      const value = await guardTab(tab, () => evaluate.call(tab.page, expression, undefined, undefined, !isMainWorld));
      // JSON has no undefined, so an expression without a value comes back as null.
      const json = JSON.stringify(value ?? null, null, 2);
      return deliver(ctx, session, args, {
        field: "value",
        value: value ?? null,
        content: json,
        prefix: `eval-${tab.id}`,
        extension: "json",
      });
    }
    case "extract": {
      const tab = ctx.registry.currentTab(session);
      const schema = parseExtractSchema(await schemaText(requiredString(args, "schema")));
      const root = optionalElement(tab, args) ?? tab.page.locator(":root");
      const rows = await guardTab(tab, () => root.evaluate(extractRowsInPage, schema, undefined, true));
      const written = await deliver(ctx, session, args, {
        field: "rows",
        value: rows,
        content: JSON.stringify(rows, null, 2),
        prefix: `extract-${tab.id}`,
        extension: "json",
      });
      return {
        lines: [`rows: ${rows.length}`, ...written.lines],
        fields: { count: rows.length, ...written.fields },
        replay: optionalRefReplay(tab, args),
      };
    }
    case "wait": {
      const tab = ctx.registry.currentTab(session);
      const condition = parseWaitCondition(args);
      const startedAtMs = Date.now();
      try {
        await guardTab(tab, () => waitForCondition(tab.page, condition, timeoutMs));
      } catch (err) {
        if (!(err instanceof CommandError) || err.code !== "timeout") throw err;
        const title = await tab.page.title().catch(() => "");
        throw new CommandError(
          "timeout",
          `no ${describeWaitCondition(condition)} within ${timeoutMs} ms`,
          `the tab is at ${tab.page.url()}, title "${title}"; raise --timeout-ms or check the page with snapshot`,
        );
      }
      const waitedMs = Date.now() - startedAtMs;
      const described = await describeTab(tab, `${describeWaitCondition(condition)} after ${waitedMs} ms`);
      return { lines: described.lines, fields: { ...described.fields, waitedMs } };
    }
    case "watch": {
      const kinds = new Set(parseWatchEventKinds(optionalString(args, "events"), ctx.mode));
      const urlGlob = optionalString(args, "url");
      const limit = args.count === undefined ? undefined : Number(args.count);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
        throw new CommandError("bad_args", `--count must be a positive integer, got ${String(args.count)}`);
      let count = 0;
      let finish: (reason: "count" | "timeout" | "disconnected") => void = () => {};
      const finished = new Promise<"count" | "timeout" | "disconnected">((resolve) => {
        finish = resolve;
      });
      const deliverEvent = (event: WatchEvent) => {
        if (!kinds.has(event.kind) || (limit !== undefined && count >= limit)) return;
        if (urlGlob !== undefined && !urlGlobMatches(urlGlob, urlOfEvent(event) ?? "")) return;
        count++;
        call.emit({ line: watchEventLine(event), fields: watchEventFields(event) });
        if (limit !== undefined && count >= limit) finish("count");
      };
      const unsubscribe = ctx.events.subscribe(session, deliverEvent);
      const stopConsole = kinds.has("console")
        ? ctx.diagnostics.follow(session, (message) =>
            deliverEvent({ kind: "console", tabId: message.tabId, message, atMs: message.atMs }),
          )
        : () => {};
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      call.disconnected.addEventListener("abort", () => finish("disconnected"), { once: true });
      const reason = await finished;
      clearTimeout(timer);
      unsubscribe();
      stopConsole();
      return {
        lines: [`watched ${count} events, stopped on ${reason}`],
        fields: { count, reason, events: [...kinds] },
      };
    }
    case "network-list": {
      const entries = ctx.network.list(session, {
        urlGlob: optionalString(args, "url"),
        types: optionalString(args, "type"),
        status: optionalString(args, "status"),
      });
      const dropped = ctx.network.droppedCount(session);
      const header = [`requests: ${entries.length}`, ...(dropped > 0 ? [`dropped from buffer: ${dropped}`] : [])];
      const written = await deliver(ctx, session, args, {
        field: "requests",
        value: entries.map(networkSummary),
        content: entries.map(networkLine).join("\n"),
        prefix: "network",
        extension: "txt",
      });
      return {
        lines: entries.length === 0 ? header : [...header, ...written.lines],
        fields: { count: entries.length, dropped, ...written.fields },
      };
    }
    case "network-get": {
      const entry = networkEntryArg(ctx, session, args);
      const replay =
        optionalString(args, "id") === undefined ? undefined : { requestUrlGlob: requestUrlGlob(entry.url) };
      const detail = {
        ...networkSummary(entry),
        requestHeaders: entry.requestHeaders,
        postData: entry.postData,
        statusText: entry.statusText,
        responseHeaders: entry.responseHeaders,
        timing: entry.timing,
        failure: entry.failure,
      };
      const lines = [
        networkLine(entry),
        ...Object.entries(entry.requestHeaders).map(([name, value]) => `> ${name}: ${value}`),
        ...(entry.postData === undefined
          ? []
          : [
              `> body: ${entry.postData.length > 500 ? `${entry.postData.slice(0, 500)}... (${Buffer.byteLength(entry.postData)} bytes, full text in --json)` : entry.postData}`,
            ]),
        ...Object.entries(entry.responseHeaders).map(([name, value]) => `< ${name}: ${value}`),
      ];
      if (args.body !== true) return { lines, fields: detail, replay };
      const body = await ctx.network.body(entry);
      const extension = bodyExtension(entry.responseHeaders);
      if (isTextual(entry.responseHeaders)) {
        const text = body.toString("utf8");
        const written = await deliver(ctx, session, args, {
          field: "body",
          value: text,
          content: text,
          prefix: `body-${entry.id}`,
          extension,
        });
        return { lines: [...lines, ...written.lines], fields: { ...detail, ...written.fields }, replay };
      }
      const path = await outputPath(ctx, session, args, `body-${entry.id}`, extension);
      await writeFile(path, body);
      return {
        lines: [...lines, `body: ${path}`, `bytes: ${body.byteLength}`],
        fields: { ...detail, path, bytes: body.byteLength },
        replay,
      };
    }
    case "network-har-start": {
      ctx.network.startHar(session);
      return { lines: ["recording HAR for this session"], fields: { session } };
    }
    case "network-har-stop": {
      const { entries, droppedCount } = ctx.network.stopHar(session);
      const bodies = new Map<string, HarBody>();
      // Text bodies go into the HAR; binary bodies would bloat it past what an agent can read.
      await Promise.all(
        entries
          .filter((entry) => entry.state === "finished" && isTextual(entry.responseHeaders))
          .map(async (entry) => {
            const body = await ctx.network.body(entry).catch(() => undefined);
            if (body !== undefined) bodies.set(entry.id, { text: body.toString("utf8"), encoding: undefined });
          }),
      );
      const har = buildHar(entries, bodies, ctx.version);
      const path = await outputPath(ctx, session, args, "network", "har");
      await writeFile(path, JSON.stringify(har, null, 2));
      return {
        lines: [
          `har: ${path}`,
          `entries: ${har.log.entries.length}`,
          `bodies: ${bodies.size}`,
          ...(droppedCount > 0 ? [`dropped past 10000: ${droppedCount}`] : []),
        ],
        fields: { path, entries: har.log.entries.length, bodies: bodies.size, dropped: droppedCount },
      };
    }
    case "route-block": {
      const rule = await ctx.routes.block(session, requiredString(args, "glob"));
      return { lines: [`blocking ${rule.glob}`], fields: { rules: ctx.routes.rulesOf(session).map(ruleSummary) } };
    }
    case "route-mock": {
      const rule = await ctx.routes.mock(session, requiredString(args, "glob"), requiredString(args, "file"));
      return { lines: [`mocking ${rule.glob}`], fields: { rules: ctx.routes.rulesOf(session).map(ruleSummary) } };
    }
    case "route-list": {
      const rules = ctx.routes.rulesOf(session).map(ruleSummary);
      return {
        lines:
          rules.length === 0
            ? ["no routes"]
            : rules.map((rule) => `${rule.kind} ${rule.glob}${rule.file === undefined ? "" : ` ${rule.file}`}`),
        fields: { rules },
      };
    }
    case "route-clear": {
      const cleared = await ctx.routes.clear(session);
      return { lines: [`cleared ${cleared} routes`], fields: { cleared } };
    }
    case "login": {
      const url = requiredString(args, "url");
      const until = optionalString(args, "until");
      const browserContextId = ctx.registry.browserContextOf(session);
      const page = await ctx.engine.openForegroundPage(browserContextId);
      const tab = ctx.registry.adoptPage(session, page, true);
      await ctx.consoleCaptureReady(tab);
      try {
        await navigate(page, url, "domcontentloaded", timeoutMs);
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
      const closed = new Promise<"closed">((resolve) => page.once("close", () => resolve("closed")));
      const reached =
        until === undefined
          ? new Promise<never>(() => {})
          : page
              .waitForURL((current) => urlGlobMatches(until, current.href), { timeout: 0, waitUntil: "commit" })
              .then(() => "reached" as const);
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), timeoutMs);
      });
      const outcome = await Promise.race([closed, reached.catch(() => "closed" as const), expired]);
      clearTimeout(timer);
      if (outcome === "expired") {
        throw new CommandError(
          "timeout",
          `login did not finish within ${timeoutMs} ms`,
          until === undefined
            ? "close the tab when signed in, or pass --until <url-glob>"
            : `the tab never reached ${until}`,
        );
      }
      const cookieCount = (await ctx.engine.cookies([url], browserContextId)).length;
      const lines =
        outcome === "reached"
          ? [`signed in, ${tab.id} reached ${page.url()}`, `cookies for ${new URL(url).origin}: ${cookieCount}`]
          : [`login tab closed`, `cookies for ${new URL(url).origin}: ${cookieCount}`];
      return { lines, fields: { tab: tab.id, outcome, url: tab.isClosed ? undefined : page.url(), cookieCount } };
    }
    case "cookies": {
      const domain = optionalString(args, "domain")?.replace(/^\./, "");
      const cookies = (await ctx.engine.cookies(undefined, ctx.registry.browserContextOf(session))).filter(
        (cookie) => domain === undefined || cookieMatchesDomain(cookie, domain),
      );
      const lines = cookies.map(
        (cookie) =>
          `${cookie.domain} ${cookie.path} ${cookie.name}${cookie.expires > 0 ? ` expires ${new Date(cookie.expires * 1000).toISOString()}` : " session"}`,
      );
      const written = await deliver(ctx, session, args, {
        field: "cookies",
        value: cookies,
        content: JSON.stringify(cookies, null, 2),
        prefix: "cookies",
        extension: "json",
      });
      // Plain output lists cookies without their values; the values are in --json and the file.
      const { path } = written.fields;
      const shown = typeof path === "string" ? [`json: ${path}`] : lines;
      return { lines: [`cookies: ${cookies.length}`, ...shown], fields: { count: cookies.length, ...written.fields } };
    }
    case "state-save": {
      const file = requiredString(args, "file");
      const origins = ctx.registry.originsOf(session);
      if (origins.length === 0)
        throw new CommandError(
          "bad_args",
          "this session has not loaded any web page yet",
          "open the sites first; state save keeps the origins this session visited",
        );
      const cookies = await ctx.engine.cookies(origins, ctx.registry.browserContextOf(session));
      const storageByOrigin = new Map<string, Array<{ name: string; value: string }>>();
      for (const tab of ctx.registry.openTabsOf(session)) {
        const origin = originOfUrl(tab.page.url());
        if (origin === undefined || storageByOrigin.has(origin)) continue;
        const items = await tab.page
          .evaluate(
            () => Object.entries(localStorage).map(([name, value]) => ({ name, value })),
            undefined,
            undefined,
            true,
          )
          .catch(() => undefined);
        if (items !== undefined) storageByOrigin.set(origin, items);
      }
      const state = {
        cookies,
        origins: [...storageByOrigin].map(([origin, localStorage]) => ({ origin, localStorage })),
      };
      await ctx.copyGuard.recordUnasked({
        kind: "state-save",
        session,
        source: profileCopyTarget(ctx, session),
        target: `file ${file}`,
        site: undefined,
        cookies: cookies.length,
        origins: [...storageByOrigin.keys()],
      });
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      const missed = origins.filter((origin) => !storageByOrigin.has(origin));
      return {
        lines: [
          `state: ${file}`,
          `cookies: ${cookies.length}`,
          `localStorage origins: ${storageByOrigin.size}`,
          ...(missed.length > 0 ? [`no open tab, localStorage skipped: ${missed.join(" ")}`] : []),
        ],
        fields: { path: file, cookies: cookies.length, origins: [...storageByOrigin.keys()], skippedOrigins: missed },
      };
    }
    case "state-load": {
      const file = requiredString(args, "file");
      const state = parseStorageState(
        await readFile(file, "utf8").catch((err: unknown) => {
          throw new CommandError(
            "bad_args",
            `cannot read state file ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      );
      await ctx.copyGuard.requireApproval({
        kind: "state-load",
        session,
        source: `file ${file}`,
        target: profileCopyTarget(ctx, session),
        site: undefined,
        cookies: state.cookies.length,
        origins: state.origins.map((entry) => entry.origin),
      });
      const browserContextId = ctx.registry.browserContextOf(session);
      await ctx.engine.addCookies(state.cookies, browserContextId);
      for (const origin of state.origins) await writeOriginStorage(ctx, origin, timeoutMs, browserContextId);
      return {
        lines: [
          `loaded ${file}`,
          `cookies: ${state.cookies.length}`,
          `localStorage origins: ${state.origins.length}`,
          ...state.origins
            .filter((origin) => origin.indexedDB.length > 0)
            .map((origin) => `${origin.origin}: IndexedDB ${origin.indexedDB.map((db) => db.name).join(" ")}`),
          browserContextId === undefined
            ? "the profile is shared, so every session now sees this state"
            : "loaded into this isolated session only",
        ],
        fields: { path: file, cookies: state.cookies.length, origins: state.origins.map((entry) => entry.origin) },
      };
    }
    case "state-export": {
      const site = siteFromInput(requiredString(args, "site"));
      if (isGoogleHost(site))
        throw new CommandError(
          "bad_args",
          `patchrome does not export Google logins`,
          "Google binds its sessions to the device; sign in on the other machine with `patchrome login`",
        );
      const file = requiredString(args, "file");
      const browserContextId = ctx.registry.browserContextOf(session);
      const isExported = (host: string) => hostBelongsToSite(host, site) && !isGoogleHost(host);
      const cookies = (await ctx.engine.cookies(undefined, browserContextId)).filter((cookie) =>
        isExported(cookie.domain),
      );
      // Chrome writes storage to disk a few seconds late, and never for an isolated session, so the origins every
      // session in the same cookie jar visited, and the cookie hosts, count too.
      const candidates = new Set(
        ctx.registry
          .sessionNames()
          .filter((name) => ctx.registry.browserContextOf(name) === browserContextId)
          .flatMap((name) => ctx.registry.originsOf(name))
          .filter((origin) => isExported(new URL(origin).hostname)),
      );
      for (const cookie of cookies) candidates.add(`https://${cookie.domain.replace(/^\./, "")}`);
      if (browserContextId === undefined) {
        const workDir = await mkdtemp(join(tmpdir(), "patchrome-storage-origins-"));
        try {
          const onDisk = await siteStorageOrigins(join(ctx.engine.userDataDir(), "Default"), site, workDir);
          for (const origin of onDisk) if (isExported(new URL(origin).hostname)) candidates.add(origin);
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      }
      const stored: OriginStorage[] = [];
      for (const origin of [...candidates].toSorted()) {
        const storage = await readOriginStorage(ctx, origin, timeoutMs, browserContextId);
        if (storage.localStorage.length > 0 || storage.indexedDB.length > 0) stored.push(storage);
      }
      const source = profileCopyTarget(ctx, session);
      if (cookies.length === 0 && stored.length === 0)
        throw new CommandError(
          "bad_args",
          `${source} has no cookies or storage for ${site}`,
          "sign in to the site first with `patchrome login`",
        );
      await ctx.copyGuard.requireApproval({
        kind: "state-export",
        session,
        source,
        target: `file ${file}`,
        site,
        cookies: cookies.length,
        origins: stored.map((origin) => origin.origin),
      });
      const state = {
        cookies,
        origins: stored.map((origin) => ({
          origin: origin.origin,
          localStorage: origin.localStorage,
          indexedDB: toStorageStateIndexedDb(origin.indexedDB),
        })),
      };
      // The tokens go into a fresh 0600 file that then replaces the target, so they are never readable through an
      // existing file's wider mode, and a symlink at the target is replaced rather than followed.
      const partial = join(dirname(file), `.${basename(file)}.${process.pid}.partial`);
      try {
        await writeFile(partial, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await rename(partial, file);
      } catch (err) {
        await rm(partial, { force: true });
        throw err;
      }
      return {
        lines: [
          `exported ${site} to ${file}`,
          `cookies: ${cookies.length}`,
          ...stored.map(
            (origin) =>
              `${origin.origin}: ${origin.localStorage.length} localStorage items, IndexedDB ${origin.indexedDB.length === 0 ? "none" : origin.indexedDB.map((db) => db.name).join(" ")}`,
          ),
          "the file holds live session tokens; move it yourself and load it with `patchrome state load`",
        ],
        fields: {
          site,
          path: file,
          cookies: cookies.length,
          origins: stored.map((origin) => ({
            origin: origin.origin,
            localStorageItems: origin.localStorage.length,
            indexedDB: origin.indexedDB.map((db) => db.name),
          })),
        },
      };
    }
    case "state-import": {
      const site = siteFromInput(requiredString(args, "site"));
      const userDataDir = optionalString(args, "chromeUserDataDir") ?? (await ctx.engine.everydayChromeUserDataDir());
      const { profiles, lastUsedFolder } = await listChromeProfiles(userDataDir);
      const chromeProfile = resolveChromeProfile(profiles, optionalString(args, "from"), lastUsedFolder);
      const copyDir = await ctx.engine.makeProfileCopyDir();
      let read: Awaited<ReturnType<BrowserEngine["readProfileCopy"]>>;
      try {
        const origins = await copySiteLoginStorage(userDataDir, chromeProfile.folder, site, copyDir);
        read = await ctx.engine.readProfileCopy(copyDir, origins);
      } finally {
        // The copy holds decryptable cookies for every site in the profile.
        // Windows holds files a just-closed Chrome had open for a moment longer.
        await rm(copyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
      const cookies = read.cookies.filter((cookie) => hostBelongsToSite(cookie.domain, site));
      const stored = read.origins.filter((origin) => origin.localStorage.length > 0 || origin.indexedDB.length > 0);
      const source = describeChromeProfile(chromeProfile);
      if (cookies.length === 0 && stored.length === 0) {
        throw new CommandError(
          "bad_args",
          `Chrome profile ${source} has no cookies or storage for ${site}`,
          "sign in to the site in that Chrome profile first, or pick another with --from",
        );
      }
      await ctx.copyGuard.requireApproval({
        kind: "state-import",
        session,
        source: `Chrome profile ${source}`,
        target: profileCopyTarget(ctx, session),
        site,
        cookies: cookies.length,
        origins: stored.map((origin) => origin.origin),
      });
      const browserContextId = ctx.registry.browserContextOf(session);
      await ctx.engine.addCookies(cookies, browserContextId);
      for (const origin of stored) await writeOriginStorage(ctx, origin, timeoutMs, browserContextId);
      return {
        lines: [
          `imported ${site} from Chrome profile ${source}`,
          `cookies: ${cookies.length}`,
          ...stored.map(
            (origin) =>
              `${origin.origin}: ${origin.localStorage.length} localStorage items, IndexedDB ${origin.indexedDB.length === 0 ? "none" : origin.indexedDB.map((db) => db.name).join(" ")}`,
          ),
          browserContextId === undefined
            ? "the profile is shared, so every session now sees this login"
            : "imported into this isolated session only",
        ],
        fields: {
          site,
          chromeProfile,
          cookies: cookies.length,
          origins: stored.map((origin) => ({
            origin: origin.origin,
            localStorageItems: origin.localStorage.length,
            indexedDB: origin.indexedDB.map((db) => db.name),
          })),
        },
      };
    }
    case "console": {
      requireDebugProfile(ctx, "console");
      const level = parseConsoleLevel(optionalString(args, "level") ?? "debug");
      if (args.follow !== true) {
        const messages = ctx.diagnostics.messages(session, level);
        const written = await deliver(ctx, session, args, {
          field: "messages",
          value: messages,
          content: messages.map(consoleLine).join("\n"),
          prefix: "console",
          extension: "txt",
        });
        return {
          lines: [`messages: ${messages.length}`, ...(messages.length === 0 ? [] : written.lines)],
          fields: { count: messages.length, ...written.fields },
        };
      }
      let count = 0;
      const stopFollowing = ctx.diagnostics.follow(session, (message) => {
        if (!isAtLeast(message.level, level)) return;
        count++;
        call.emit({ line: consoleLine(message), fields: { message } });
      });
      const reason = await new Promise<"timeout" | "disconnected">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        call.disconnected.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve("disconnected");
          },
          { once: true },
        );
      });
      stopFollowing();
      return { lines: [`followed for ${timeoutMs} ms, ${count} messages`], fields: { count, reason } };
    }
    case "errors": {
      requireDebugProfile(ctx, "errors");
      const errors = ctx.diagnostics.errors(session);
      const text = errors
        .map(
          (error) =>
            `${error.id} ${error.tabId} ${error.message}${error.url === undefined ? "" : ` (${error.url}:${error.line})`}${error.stack === undefined ? "" : `\n${error.stack}`}`,
        )
        .join("\n");
      const written = await deliver(ctx, session, args, {
        field: "errors",
        value: errors,
        content: text,
        prefix: "errors",
        extension: "txt",
      });
      return {
        lines: [`errors: ${errors.length}`, ...(errors.length === 0 ? [] : written.lines)],
        fields: { count: errors.length, ...written.fields },
      };
    }
    case "trace-start": {
      requireDebugProfile(ctx, "trace start");
      if (ctx.trace.owner !== undefined) {
        throw new CommandError(
          "bad_args",
          ctx.trace.owner === session
            ? "this session is already tracing"
            : `session ${ctx.trace.owner} is already tracing this browser`,
          ctx.trace.owner === session
            ? "run `patchrome trace stop`"
            : "a trace covers every tab in the profile, so only one runs at a time",
        );
      }
      await ctx.engine.startTrace();
      ctx.trace.owner = session;
      return { lines: ["tracing, covers every tab in this profile"], fields: { session } };
    }
    case "trace-stop": {
      requireDebugProfile(ctx, "trace stop");
      if (ctx.trace.owner !== session) {
        throw new CommandError(
          "bad_args",
          ctx.trace.owner === undefined ? "no trace is running" : `session ${ctx.trace.owner} owns the running trace`,
          "run `patchrome trace start` first",
        );
      }
      const path = await outputPath(ctx, session, args, "trace", "zip");
      await ctx.engine.stopTrace(path);
      ctx.trace.owner = undefined;
      return { lines: [`trace: ${path}`, "open with `npx playwright show-trace <file>`"], fields: { path } };
    }
    case "cdp": {
      requireDebugProfile(ctx, "cdp");
      const tab = ctx.registry.currentTab(session);
      const method = requiredString(args, "method");
      if (!/^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/.test(method))
        throw new CommandError(
          "bad_args",
          `${method} is not a CDP method`,
          "use Domain.method, for example Performance.getMetrics",
        );
      const params = parseCdpParams(optionalString(args, "params"));
      const cdp = await guardTab(tab, () => ctx.engine.openCdpSession(tab.page));
      try {
        const reply = await guardTab(tab, () => cdp.send(method as "Runtime.evaluate", params as never));
        return await deliver(ctx, session, args, {
          field: "result",
          value: reply,
          content: JSON.stringify(reply, null, 2),
          prefix: `cdp-${tab.id}`,
          extension: "json",
        });
      } catch (err) {
        if (err instanceof CommandError && err.code === "bad_args")
          throw new CommandError("bad_args", `${method} failed: ${err.message}`);
        throw err;
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
    case "cdp-help": {
      requireDebugProfile(ctx, "cdp help");
      const endpoint = ctx.engine.debuggingEndpoint();
      if (endpoint === undefined)
        throw new CommandError(
          "bad_args",
          "the debug browser exposed no debugging endpoint",
          "see `patchrome daemon logs`",
        );
      const response = await fetch(`${endpoint.httpUrl}/json/protocol`);
      const schema = parseProtocolSchema(await response.text());
      const topic = optionalString(args, "topic");
      const help = protocolHelp(schema, topic).join("\n");
      return deliver(ctx, session, args, {
        field: "help",
        value: help,
        content: help,
        prefix: "cdp-help",
        extension: "txt",
      });
    }
    case "devtools-url": {
      requireDebugProfile(ctx, "devtools-url");
      const endpoint = ctx.engine.debuggingEndpoint();
      if (endpoint === undefined)
        throw new CommandError(
          "bad_args",
          "the debug browser exposed no debugging endpoint",
          "see `patchrome daemon logs`",
        );
      return {
        lines: [
          endpoint.httpUrl,
          `browser: ${endpoint.browserWsUrl}`,
          `attach: chrome-devtools start --browserUrl ${endpoint.httpUrl}`,
        ],
        fields: { ...endpoint },
      };
    }
    case "session": {
      const tabs = ctx.registry.tabsOf(session);
      const label = ctx.registry.labelOf(session);
      await ctx.regroupTabs(session);
      const openPages = ctx.registry.openTabsOf(session).map((tab) => tab.page);
      const tabGroups =
        openPages.length === 0 || ctx.registry.browserContextOf(session) !== undefined
          ? []
          : await ctx.engine.describeTabGroups(openPages).catch(() => []);
      return {
        lines: [
          `session: ${session}`,
          ...(label === undefined ? [] : [`label: ${label}`]),
          ...tabGroups.map((group) => `tab group: ${group.title} (${group.color}, ${group.tabCount} tabs)`),
          ...tabs.map((tab) => `${tab.isCurrent ? "*" : " "} ${tab.id} ${tab.url}`),
        ],
        fields: { session, label, tabGroups, tabs },
      };
    }
    case "sessions": {
      const pattern = optionalString(args, "pattern");
      const matches = (name: string) => pattern === undefined || nameGlobMatches(pattern, name);
      const live = ctx.registry
        .sessionNames()
        .filter(matches)
        .map((name) => ({
          session: name,
          label: ctx.registry.labelOf(name),
          tabCount: ctx.registry.openTabsOf(name).length,
          isIsolated: ctx.registry.browserContextOf(name) !== undefined,
          isAwaitingRestore: false,
        }));
      const saved = ctx
        .savedSessionNames()
        .filter(matches)
        .map((name) => ({ session: name, label: undefined, tabCount: 0, isIsolated: false, isAwaitingRestore: true }));
      const all = [...live, ...saved].toSorted((a, b) => a.session.localeCompare(b.session));
      if (pattern !== undefined && all.length === 0)
        throw new CommandError("bad_args", `no session matches ${pattern}`, "run `patchrome sessions` to list them");
      return {
        lines:
          all.length === 0
            ? ["no sessions"]
            : all.map(
                (entry) =>
                  `${entry.session} ${entry.isAwaitingRestore ? "saved, reopens on its next command" : `${entry.tabCount} tabs${entry.isIsolated ? " isolated" : ""}`}${entry.label === undefined ? "" : ` label: ${entry.label}`}`,
              ),
        fields: { sessions: all },
      };
    }
    case "session-label": {
      const label = requiredString(args, "label").trim();
      if (label === "") throw new CommandError("bad_args", "session label needs non-blank text");
      ctx.registry.setLabel(session, label);
      await ctx.regroupTabs(session);
      return { lines: [`labelled ${session}: ${label}`], fields: { session, label } };
    }
    case "session-close": {
      const pattern = optionalString(args, "pattern");
      if (pattern === undefined) {
        const closedTabs = await closeSession(ctx, session);
        return { lines: [`closed session ${session}, ${closedTabs} tabs`], fields: { session, closedTabs } };
      }
      const live = ctx.registry.sessionNames().filter((name) => nameGlobMatches(pattern, name));
      const saved = ctx.savedSessionNames().filter((name) => nameGlobMatches(pattern, name));
      if (live.length === 0 && saved.length === 0) {
        const known = [...ctx.registry.sessionNames(), ...ctx.savedSessionNames()];
        throw new CommandError(
          "bad_args",
          `no session ${isNamePattern(pattern) ? "matches" : "named"} ${pattern}`,
          known.length === 0 ? "no sessions are open" : `sessions: ${known.toSorted().join(" ")}`,
        );
      }
      const closed: Array<{ session: string; closedTabs: number }> = [];
      for (const name of live) closed.push({ session: name, closedTabs: await closeSession(ctx, name) });
      for (const name of saved) {
        ctx.forgetSavedSession(name);
        closed.push({ session: name, closedTabs: 0 });
      }
      closed.sort((a, b) => a.session.localeCompare(b.session));
      return {
        lines: closed.map((entry) => `closed session ${entry.session}, ${entry.closedTabs} tabs`),
        fields: { sessions: closed },
      };
    }
    case "daemon-status": {
      const tabCount = ctx.registry.allTabs().length;
      const sessions = ctx.registry.sessionNames();
      return {
        lines: [
          `profile: ${ctx.profile}`,
          `mode: ${ctx.mode}`,
          ...(ctx.engine.debuggingEndpoint() === undefined
            ? []
            : [`devtools: ${ctx.engine.debuggingEndpoint()?.httpUrl}`]),
          `build: ${ctx.buildId}`,
          `pid: ${process.pid}`,
          `uptime: ${Math.round((Date.now() - ctx.startedAtMs) / 1000)} s`,
          `sessions: ${sessions.length}`,
          `tabs: ${tabCount}`,
        ],
        fields: {
          profile: ctx.profile,
          mode: ctx.mode,
          devtoolsUrl: ctx.engine.debuggingEndpoint()?.httpUrl,
          buildId: ctx.buildId,
          pid: process.pid,
          startedAtMs: ctx.startedAtMs,
          sessions,
          tabCount,
        },
      };
    }
    case "daemon-stop": {
      ctx.requestShutdown();
      return { lines: ["daemon stopping"], fields: { pid: process.pid } };
    }
  }
}

// Closes every tab of the session and drops what the daemon kept for it. Returns how many tabs closed.
async function closeSession(ctx: CommandContext, session: string): Promise<number> {
  const tabs = ctx.registry.openTabsOf(session);
  const browserContextId = ctx.registry.browserContextOf(session);
  await Promise.all(tabs.map((tab) => tab.page.close().catch(() => {})));
  if (browserContextId !== undefined) await ctx.engine.disposeIsolatedContext(browserContextId).catch(() => {});
  ctx.registry.forget(session);
  ctx.network.forget(session);
  ctx.diagnostics.forget(session);
  await ctx.routes.forget(session);
  if (ctx.trace.owner === session) {
    ctx.trace.owner = undefined;
    await ctx.engine
      .stopTrace(join(ctx.sessionsDir, sessionFolderName(session), "abandoned-trace.zip"))
      .catch(() => {});
  }
  return tabs.length;
}

// A session picks shared or isolated with its first tab and keeps it: moving tabs between cookie jars
// would leak one site's login into the other.
async function browserContextForOpen(
  ctx: CommandContext,
  session: string,
  isIsolatedRequest: boolean,
): Promise<string | undefined> {
  const existing = ctx.registry.browserContextOf(session);
  if (!isIsolatedRequest || existing !== undefined) return existing;
  if (ctx.registry.openTabsOf(session).length > 0) {
    throw new CommandError(
      "bad_args",
      `session ${session} already browses the shared profile`,
      "run `patchrome session close`, then `open --isolated`",
    );
  }
  const browserContextId = await ctx.engine.createIsolatedContext();
  ctx.registry.isolate(session, browserContextId);
  return browserContextId;
}

// Chrome closes with the daemon, so a restart reopens each saved tab at its last URL under the same id.
// An isolated session gets a fresh in-memory context: its cookies did not survive. A tab whose page fails
// to load is left out, and a command on it gives tab_gone.
// A restore that fails part way closes what it opened, so the saved session stays whole for the next attempt
// instead of being replaced by its first few tabs.
export async function restoreSession(
  ctx: CommandContext,
  saved: SavedSession,
  timeoutMs: number,
): Promise<{ restored: string[]; dropped: string[] }> {
  try {
    return await reopenSavedTabs(ctx, saved, timeoutMs);
  } catch (err) {
    await closeSession(ctx, saved.name);
    throw err;
  }
}

async function reopenSavedTabs(
  ctx: CommandContext,
  saved: SavedSession,
  timeoutMs: number,
): Promise<{ restored: string[]; dropped: string[] }> {
  const restored: string[] = [];
  const dropped: string[] = [];
  ctx.registry.setLabel(saved.name, saved.label);
  if (saved.isIsolated) ctx.registry.isolate(saved.name, await ctx.engine.createIsolatedContext());
  const browserContextId = ctx.registry.browserContextOf(saved.name);
  for (const { id, url } of saved.tabs) {
    const page = await ctx.engine.openBackgroundPage(browserContextId);
    const tab = ctx.registry.adoptPage(saved.name, page, false, id);
    await ctx.consoleCaptureReady(tab);
    if (url.startsWith("about:blank")) {
      restored.push(id);
      continue;
    }
    try {
      await navigate(page, url, "domcontentloaded", timeoutMs);
      restored.push(id);
    } catch {
      await page.close().catch(() => {});
      dropped.push(id);
    }
  }
  if (saved.currentTabId !== undefined && restored.includes(saved.currentTabId))
    ctx.registry.switchTo(saved.name, saved.currentTabId);
  return { restored, dropped };
}

function requireDebugProfile(ctx: CommandContext, command: string): void {
  switch (ctx.mode) {
    case "debug":
      return;
    case "stealth":
      throw new CommandError(
        "unsupported_in_stealth",
        `${command} needs a debug profile; profile ${ctx.profile} is stealth`,
        `run it with --profile debug; stealth profiles keep Runtime, Tracing and the debugging port off so sites cannot detect them`,
      );
  }
}

function parseCdpParams(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  return parseJsonInput(
    z.record(z.string(), z.unknown()),
    raw,
    "CDP params",
    `pass an object, for example '{"expression": "1 + 1"}'`,
  );
}

async function schemaText(schemaArg: string): Promise<string> {
  if (schemaArg.trimStart().startsWith("{")) return schemaArg;
  try {
    return await readFile(schemaArg, "utf8");
  } catch (err) {
    throw new CommandError(
      "bad_args",
      `cannot read schema file ${schemaArg}: ${err instanceof Error ? err.message : String(err)}`,
      "pass a JSON file path or inline JSON starting with {",
    );
  }
}

function networkSummary(entry: NetworkEntry) {
  return {
    id: entry.id,
    tab: entry.tabId,
    method: entry.method,
    url: entry.url,
    type: entry.resourceType,
    state: entry.state,
    status: entry.status,
    durationMs: entry.durationMs,
  };
}

function networkLine(entry: NetworkEntry): string {
  const status = entry.state === "failed" ? `failed(${entry.failure})` : String(entry.status ?? "pending");
  const duration = entry.durationMs === undefined ? "" : ` ${entry.durationMs}ms`;
  return `${entry.id} ${entry.tabId} ${status} ${entry.resourceType} ${entry.method} ${entry.url}${duration}`;
}

function ruleSummary(rule: RouteRule) {
  return rule.kind === "mock"
    ? { kind: rule.kind, glob: rule.glob, file: rule.file }
    : { kind: rule.kind, glob: rule.glob, file: undefined };
}

function cookieMatchesDomain(cookie: Cookie, domain: string): boolean {
  const cookieDomain = cookie.domain.replace(/^\./, "");
  return cookieDomain === domain || cookieDomain.endsWith(`.${domain}`);
}

function originOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

const keyPathSchema = { keyPath: z.string().optional(), keyPathArray: z.array(z.string()).optional() };

const indexedDbSchema: z.ZodType<StorageStateIndexedDb> = z.object({
  name: z.string(),
  version: z.number(),
  stores: z.array(
    z.object({
      name: z.string(),
      autoIncrement: z.boolean(),
      ...keyPathSchema,
      indexes: z.array(z.object({ name: z.string(), ...keyPathSchema, unique: z.boolean(), multiEntry: z.boolean() })),
      records: z.array(
        z.object({
          key: z.unknown().optional(),
          keyEncoded: z.unknown().optional(),
          value: z.unknown().optional(),
          valueEncoded: z.unknown().optional(),
        }),
      ),
    }),
  ),
});

const storageStateSchema = z.object({
  cookies: z.array(z.looseObject({ name: z.string(), value: z.string(), domain: z.string(), path: z.string() })),
  origins: z.array(
    z.object({
      origin: z.string().refine((origin) => originOfUrl(origin) === origin, "must be an http(s) origin"),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
      indexedDB: z.array(indexedDbSchema).optional(),
    }),
  ),
});

interface StorageState {
  cookies: Cookie[];
  origins: OriginStorage[];
}

function profileCopyTarget(ctx: CommandContext, session: string): string {
  return ctx.registry.browserContextOf(session) === undefined
    ? `patchrome profile ${ctx.profile} (shared by every session)`
    : `isolated session ${session} of patchrome profile ${ctx.profile}`;
}

// Accepts the files `state save` and `state export` write, which are also Playwright's storageState format.
export function parseStorageState(raw: string): StorageState {
  const state = parseJsonInput(
    storageStateSchema,
    raw,
    "state file",
    "use a file written by `patchrome state save`, `patchrome state export` or Playwright's storageState()",
  );
  return {
    cookies: state.cookies as unknown as Cookie[],
    origins: state.origins.map(({ origin, localStorage, indexedDB = [] }) => ({
      origin,
      localStorage,
      indexedDB: fromStorageStateIndexedDb(indexedDB),
    })),
  };
}

async function writeOriginStorage(
  ctx: CommandContext,
  storage: OriginStorage,
  timeoutMs: number,
  browserContextId: string | undefined,
): Promise<void> {
  if (storage.localStorage.length === 0 && storage.indexedDB.length === 0) return;
  await onOriginWithoutSite(ctx, storage.origin, timeoutMs, browserContextId, (page) =>
    page.evaluate(
      writeOriginStorageInPage,
      { localStorage: storage.localStorage, indexedDB: storage.indexedDB },
      undefined,
      true,
    ),
  );
}

async function readOriginStorage(
  ctx: CommandContext,
  origin: string,
  timeoutMs: number,
  browserContextId: string | undefined,
): Promise<OriginStorage> {
  const storage = await onOriginWithoutSite(ctx, origin, timeoutMs, browserContextId, (page) =>
    page.evaluate(readOriginStorageInPage, undefined, undefined, true),
  );
  return { origin, ...storage };
}

// Reaches an origin's storage without contacting the site: a background tab loads the origin from a route that
// answers with an empty page, runs, and closes. The tab is never adopted by a session.
async function onOriginWithoutSite<T>(
  ctx: CommandContext,
  origin: string,
  timeoutMs: number,
  browserContextId: string | undefined,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await ctx.engine.openBackgroundPage(browserContextId);
  try {
    await page.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>patchrome state</title>" }),
    );
    await page.goto(`${origin}/`, { waitUntil: "commit", timeout: timeoutMs });
    return await run(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// A ref, or a locator from --role, --text, --label or --selector, for commands that act on one element.
function targetLocator(tab: Tab, target: Exclude<Target, { kind: "point" }>): Locator {
  return target.kind === "ref" ? refLocator(tab, target.ref) : elementLocator(tab.page, target);
}

// A ref names an element on one page only; history replays it as the locator its snapshot line gives.
function refReplay(tab: Tab, target: Target): ReplayHint | undefined {
  if (target.kind !== "ref") return undefined;
  const ref = parseRef(target.ref);
  return {
    refLocator: locatorForRef(tab.generations.latestSnapshot, ref) ?? {
      flags: ["--ref", ref],
      notes: [`@${ref} was not found in the snapshot; replace it with a locator`],
    },
  };
}

function optionalRefReplay(tab: Tab, args: CommandArgs): ReplayHint | undefined {
  const ref = optionalString(args, "ref");
  return ref === undefined ? undefined : refReplay(tab, { kind: "ref", ref });
}

// text, screenshot and extract read the whole page unless given an element.
function optionalElement(tab: Tab, args: CommandArgs): Locator | undefined {
  const isGiven = ["ref", "selector", "role", "text", "label"].some((name) => typeof args[name] === "string");
  if (!isGiven) return undefined;
  const target = parseTarget(args, { allowsPoint: false });
  return target.kind === "point" ? undefined : targetLocator(tab, target);
}

// `network get --url <glob>` takes the newest matching request that finished, so a script need not know ids.
function networkEntryArg(ctx: CommandContext, session: string, args: CommandArgs): NetworkEntry {
  const id = optionalString(args, "id");
  const urlGlob = optionalString(args, "url");
  if ((id === undefined) === (urlGlob === undefined))
    throw new CommandError(
      "bad_args",
      "network get takes a request id or --url <glob>",
      "network get n17, or network get --url '*/api/items*'",
    );
  if (id !== undefined) return ctx.network.entry(session, id);
  const matches = ctx.network.list(session, { urlGlob, types: undefined, status: undefined });
  const newest = matches.findLast((entry) => entry.state === "finished") ?? matches.at(-1);
  if (newest === undefined)
    throw new CommandError(
      "bad_args",
      `no request in this session matches ${urlGlob}`,
      "globs match the whole URL; run `patchrome network list` to see what loaded",
    );
  return newest;
}

function refLocator(tab: Tab, refInput: string): Locator {
  const ref = parseRef(refInput);
  tab.generations.assertRefCurrent(ref);
  return tab.page.locator(`aria-ref=${ref}`);
}

async function navigate(page: Page, url: string, waitUntil: WaitState, timeoutMs: number): Promise<void> {
  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
  } catch (err) {
    throw translateError(err, "navigation_failed");
  }
}

// Playwright errors become the closed error set; anything unrecognised surfaces as the fallback code.
async function guardTab<T>(tab: Tab, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (tab.isClosed)
      throw new CommandError("tab_gone", `tab ${tab.id} closed during the command`, "run `patchrome open <url>`");
    throw translateError(err, "bad_args");
  }
}

function translateError(err: unknown, fallback: "navigation_failed" | "bad_args"): CommandError {
  if (err instanceof CommandError) return err;
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
  if (err instanceof Error && err.name === "TimeoutError")
    return new CommandError("timeout", message, "raise --timeout-ms or wait for a condition first");
  if (/Target page, context or browser has been closed|Target closed/.test(message))
    return new CommandError("tab_gone", message, "run `patchrome open <url>`");
  return new CommandError(fallback, message);
}

async function describeTab(tab: Tab, action: string): Promise<CommandData> {
  const url = tab.page.url();
  const title = await tab.page.title().catch(() => "");
  return { lines: [action, `url: ${url}`, `title: ${title}`], fields: { tab: tab.id, url, title } };
}

interface Payload {
  // Name of the --json field that carries the value when it is inline.
  field: string;
  value: unknown;
  // What plain output prints and what the file holds.
  content: string;
  prefix: string;
  extension: string;
}

// Where a value goes: `--out <file>` always writes that file, `--inline` always prints it, and without either
// a value over 2 KB goes to a session file. A script passes one of the two, so the output shape never
// depends on the page.
async function deliver(
  ctx: CommandContext,
  session: string,
  args: CommandArgs,
  payload: Payload,
): Promise<CommandData> {
  const bytes = Buffer.byteLength(payload.content);
  if (optionalString(args, "out") === undefined && (args.inline === true || bytes <= inlineLimitBytes)) {
    return { lines: [payload.content], fields: { [payload.field]: payload.value } };
  }
  const path = await outputPath(ctx, session, args, payload.prefix, payload.extension);
  await writeFile(path, payload.content);
  return { lines: [`${payload.field}: ${path}`, `bytes: ${bytes}`], fields: { path, bytes } };
}

async function outputPath(
  ctx: CommandContext,
  session: string,
  args: CommandArgs,
  prefix: string,
  extension: string,
): Promise<string> {
  const out = optionalString(args, "out");
  if (out === undefined) return sessionFilePath(ctx, session, prefix, extension);
  await mkdir(dirname(out), { recursive: true });
  return out;
}

async function sessionFilePath(
  ctx: CommandContext,
  session: string,
  prefix: string,
  extension: string,
): Promise<string> {
  const dir = join(ctx.sessionsDir, sessionFolderName(session));
  await mkdir(dir, { recursive: true });
  const highest = Math.max(
    0,
    ...(await readdir(dir)).map((name) => Number(name.match(new RegExp(`^${prefix}-(\\d+)\\.`))?.[1] ?? 0)),
  );
  return join(dir, `${prefix}-${highest + 1}.${extension}`);
}

function requiredString(args: CommandArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new CommandError("bad_args", `missing ${name}`);
  return value;
}

function optionalString(args: CommandArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function waitStateArg(args: CommandArgs): WaitState {
  const value = args.wait ?? "load";
  if (!(waitStates as readonly unknown[]).includes(value)) {
    throw new CommandError("bad_args", `--wait must be one of ${waitStates.join(", ")}, got ${String(value)}`);
  }
  return value as WaitState;
}
