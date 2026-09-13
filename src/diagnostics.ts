import type { CDPSession } from "patchright";
import { CommandError } from "./protocol.ts";
import type { Tab } from "./sessions.ts";

export const consoleLevels = ["debug", "info", "warning", "error"] as const;
export type ConsoleLevel = (typeof consoleLevels)[number];

export interface ConsoleMessage {
  id: string;
  tabId: string;
  level: ConsoleLevel;
  text: string;
  url: string | undefined;
  line: number | undefined;
  atMs: number;
}

export interface PageError {
  id: string;
  tabId: string;
  message: string;
  stack: string | undefined;
  url: string | undefined;
  line: number | undefined;
  atMs: number;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface StackTrace {
  callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }>;
}

const consoleLimitPerSession = 1000;
const errorLimitPerSession = 200;

interface SessionDiagnostics {
  messages: ConsoleMessage[];
  errors: PageError[];
  followers: Set<(message: ConsoleMessage) => void>;
}

// Debug profile only. Patchright disables Playwright's console and pageerror events, so capture goes
// through a CDP session with Runtime enabled, which is exactly the signal a stealth profile must not send.
export class PageDiagnostics {
  #sessions = new Map<string, SessionDiagnostics>();
  #nextMessageId = 1;
  #nextErrorId = 1;
  #onPageError: (tab: Tab, pageError: PageError) => void;

  constructor(onPageError: (tab: Tab, pageError: PageError) => void = () => {}) {
    this.#onPageError = onPageError;
  }

  async record(tab: Tab, cdp: CDPSession): Promise<void> {
    cdp.on("Runtime.consoleAPICalled", (event: { type: string; args: RemoteObject[]; stackTrace?: StackTrace }) => {
      const frame = event.stackTrace?.callFrames[0];
      const message: ConsoleMessage = {
        id: `c${this.#nextMessageId++}`,
        tabId: tab.id,
        level: consoleLevelOf(event.type),
        text: event.args.map(renderRemoteObject).join(" "),
        url: frame?.url || undefined,
        line: frame === undefined ? undefined : frame.lineNumber + 1,
        atMs: Date.now(),
      };
      const diagnostics = this.#sessionFor(tab.session);
      pushCapped(diagnostics.messages, message, consoleLimitPerSession);
      for (const follower of diagnostics.followers) follower(message);
    });
    cdp.on(
      "Runtime.exceptionThrown",
      (event: {
        exceptionDetails: {
          text: string;
          url?: string;
          lineNumber: number;
          exception?: RemoteObject;
          stackTrace?: StackTrace;
        };
      }) => {
        const details = event.exceptionDetails;
        const description = details.exception?.description;
        const pageError: PageError = {
          id: `x${this.#nextErrorId++}`,
          tabId: tab.id,
          message: (description ?? details.text).split("\n")[0] ?? details.text,
          stack: description ?? formatStack(details.stackTrace),
          url: details.url,
          line: details.lineNumber + 1,
          atMs: Date.now(),
        };
        pushCapped(this.#sessionFor(tab.session).errors, pageError, errorLimitPerSession);
        this.#onPageError(tab, pageError);
      },
    );
    await cdp.send("Runtime.enable");
  }

  messages(session: string, minimumLevel: ConsoleLevel): ConsoleMessage[] {
    return (this.#sessions.get(session)?.messages ?? []).filter((message) => isAtLeast(message.level, minimumLevel));
  }

  errors(session: string): PageError[] {
    return this.#sessions.get(session)?.errors ?? [];
  }

  follow(session: string, listener: (message: ConsoleMessage) => void): () => void {
    const followers = this.#sessionFor(session).followers;
    followers.add(listener);
    return () => followers.delete(listener);
  }

  forget(session: string): void {
    this.#sessions.delete(session);
  }

  #sessionFor(session: string): SessionDiagnostics {
    let diagnostics = this.#sessions.get(session);
    if (!diagnostics) {
      diagnostics = { messages: [], errors: [], followers: new Set() };
      this.#sessions.set(session, diagnostics);
    }
    return diagnostics;
  }
}

export function parseConsoleLevel(raw: string): ConsoleLevel {
  if (!(consoleLevels as readonly string[]).includes(raw)) {
    throw new CommandError(
      "bad_args",
      `--level ${raw} is not a console level`,
      `use one of ${consoleLevels.join(", ")}; each includes the levels above it`,
    );
  }
  return raw as ConsoleLevel;
}

// CDP reports the console method called; agents filter by severity.
export function consoleLevelOf(cdpType: string): ConsoleLevel {
  if (cdpType === "error" || cdpType === "assert") return "error";
  if (cdpType === "warning") return "warning";
  if (cdpType === "debug") return "debug";
  return "info";
}

export function isAtLeast(level: ConsoleLevel, minimum: ConsoleLevel): boolean {
  return consoleLevels.indexOf(level) >= consoleLevels.indexOf(minimum);
}

export function renderRemoteObject(object: RemoteObject): string {
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === "string") return String(object.value);
  if (object.value !== undefined) return JSON.stringify(object.value);
  if (object.type === "undefined") return "undefined";
  return object.description ?? object.subtype ?? object.type;
}

function formatStack(stackTrace: StackTrace | undefined): string | undefined {
  if (!stackTrace) return undefined;
  return stackTrace.callFrames
    .map(
      (frame) =>
        `    at ${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
    )
    .join("\n");
}

function pushCapped<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.shift();
}

export function consoleLine(message: ConsoleMessage): string {
  const where = message.url === undefined ? "" : ` (${message.url}:${message.line})`;
  return `${message.id} ${message.tabId} ${message.level} ${message.text}${where}`;
}
