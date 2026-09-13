import { consoleLine, type ConsoleMessage, type PageError } from "./diagnostics.ts";
import type { NetworkEntry } from "./network.ts";
import type { ProfileMode } from "./profile-mode.ts";
import { CommandError } from "./protocol.ts";

export const watchEventKinds = ["navigation", "load", "response", "console", "error"] as const;
export type WatchEventKind = (typeof watchEventKinds)[number];

export type WatchEvent =
  | { kind: "navigation"; tabId: string; url: string; atMs: number }
  | { kind: "load"; tabId: string; url: string; atMs: number }
  | { kind: "response"; tabId: string; entry: NetworkEntry; atMs: number }
  | { kind: "console"; tabId: string; message: ConsoleMessage; atMs: number }
  | { kind: "error"; tabId: string; pageError: PageError; atMs: number };

// Console and page errors come from the Runtime domain, which only a debug profile turns on.
export function eventKindsFor(mode: ProfileMode): readonly WatchEventKind[] {
  switch (mode) {
    case "stealth":
      return ["navigation", "load", "response"];
    case "debug":
      return watchEventKinds;
  }
}

export function parseWatchEventKinds(raw: string | undefined, mode: ProfileMode): WatchEventKind[] {
  const available = eventKindsFor(mode);
  if (raw === undefined) return [...available];
  const kinds = raw.split(",").map((part) => part.trim());
  for (const kind of kinds) {
    if (!(watchEventKinds as readonly string[]).includes(kind)) {
      throw new CommandError("bad_args", `--events ${kind} is not an event`, `use any of ${watchEventKinds.join(", ")}`);
    }
    if (!(available as readonly string[]).includes(kind)) {
      throw new CommandError("unsupported_in_stealth", `watch --events ${kind} needs a debug profile`, "stealth profiles keep Runtime off so sites cannot detect them; run with --profile debug");
    }
  }
  return kinds as WatchEventKind[];
}

// The URL an event is about, which `watch --url` filters on.
export function urlOfEvent(event: WatchEvent): string | undefined {
  switch (event.kind) {
    case "navigation":
    case "load":
      return event.url;
    case "response":
      return event.entry.url;
    case "console":
      return event.message.url;
    case "error":
      return event.pageError.url;
  }
}

export function watchEventLine(event: WatchEvent): string {
  switch (event.kind) {
    case "navigation":
      return `navigation ${event.tabId} ${event.url}`;
    case "load":
      return `load ${event.tabId} ${event.url}`;
    case "response": {
      const { entry } = event;
      const status = entry.state === "failed" ? `failed(${entry.failure})` : String(entry.status ?? "pending");
      return `response ${entry.id} ${entry.tabId} ${status} ${entry.resourceType} ${entry.method} ${entry.url}${entry.durationMs === undefined ? "" : ` ${entry.durationMs}ms`}`;
    }
    case "console":
      return `console ${consoleLine(event.message)}`;
    case "error":
      return `error ${event.pageError.id} ${event.tabId} ${event.pageError.message}`;
  }
}

export function watchEventFields(event: WatchEvent): Record<string, unknown> {
  switch (event.kind) {
    case "navigation":
    case "load":
      return { kind: event.kind, tab: event.tabId, url: event.url, atMs: event.atMs };
    case "response": {
      const { entry } = event;
      return { kind: event.kind, tab: event.tabId, id: entry.id, method: entry.method, url: entry.url, type: entry.resourceType, state: entry.state, status: entry.status, durationMs: entry.durationMs, failure: entry.failure, atMs: event.atMs };
    }
    case "console":
      return { kind: event.kind, tab: event.tabId, ...event.message };
    case "error":
      return { kind: event.kind, tab: event.tabId, ...event.pageError };
  }
}

// Fans page events out to the `watch` streams of the session that owns the tab.
export class SessionEvents {
  #listeners = new Map<string, Set<(event: WatchEvent) => void>>();

  publish(session: string, event: WatchEvent): void {
    for (const listener of this.#listeners.get(session) ?? []) listener(event);
  }

  subscribe(session: string, listener: (event: WatchEvent) => void): () => void {
    let listeners = this.#listeners.get(session);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(session, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(session) === listeners) this.#listeners.delete(session);
    };
  }
}
