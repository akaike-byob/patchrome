import type { Request, Response } from "patchright";
import { parseStatusFilter, urlGlobMatches } from "./glob.ts";
import { CommandError } from "./protocol.ts";
import type { Tab } from "./sessions.ts";

export const resourceTypes = [
  "document", "stylesheet", "image", "media", "font", "script", "texttrack",
  "xhr", "fetch", "eventsource", "websocket", "manifest", "other",
] as const;
export type ResourceType = (typeof resourceTypes)[number];

export interface RequestTiming {
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

export interface NetworkEntry {
  id: string;
  tabId: string;
  session: string;
  method: string;
  url: string;
  resourceType: string;
  startedAtMs: number;
  requestHeaders: Record<string, string>;
  postData: string | undefined;
  state: "pending" | "finished" | "failed";
  status: number | undefined;
  statusText: string;
  responseHeaders: Record<string, string>;
  durationMs: number | undefined;
  timing: RequestTiming | undefined;
  failure: string | undefined;
}

export interface NetworkFilter {
  urlGlob: string | undefined;
  types: string | undefined;
  status: string | undefined;
}

// Enough for an agent to find the API call behind a page without holding a busy session's whole history.
const bufferLimitPerSession = 1000;
const harLimitPerSession = 10_000;
const postDataLimitBytes = 64 * 1024;

interface SessionNetwork {
  entries: NetworkEntry[];
  droppedCount: number;
  har: NetworkEntry[] | undefined;
  harDroppedCount: number;
}

export class NetworkLog {
  #sessions = new Map<string, SessionNetwork>();
  #responses = new Map<string, Response>();
  #nextId = 1;
  #onSettled: (entry: NetworkEntry) => void;

  // onSettled fires once per request, when it finishes or fails.
  constructor(onSettled: (entry: NetworkEntry) => void = () => {}) {
    this.#onSettled = onSettled;
  }

  record(tab: Tab): void {
    const pending = new WeakMap<Request, NetworkEntry>();
    const page = tab.page;

    page.on("request", (request) => {
      const postData = request.postData() ?? undefined;
      const entry: NetworkEntry = {
        id: `n${this.#nextId++}`,
        tabId: tab.id,
        session: tab.session,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        startedAtMs: Date.now(),
        requestHeaders: request.headers(),
        postData: postData !== undefined && Buffer.byteLength(postData) > postDataLimitBytes ? undefined : postData,
        state: "pending",
        status: undefined,
        statusText: "",
        responseHeaders: {},
        durationMs: undefined,
        timing: undefined,
        failure: undefined,
      };
      pending.set(request, entry);
      this.#append(tab.session, entry);
    });
    page.on("response", (response) => {
      const entry = pending.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.statusText = response.statusText();
      entry.responseHeaders = response.headers();
      this.#responses.set(entry.id, response);
    });
    page.on("requestfinished", (request) => {
      const entry = pending.get(request);
      if (!entry) return;
      entry.state = "finished";
      entry.durationMs = Date.now() - entry.startedAtMs;
      entry.timing = request.timing();
      this.#onSettled(entry);
    });
    page.on("requestfailed", (request) => {
      const entry = pending.get(request);
      if (!entry) return;
      entry.state = "failed";
      entry.durationMs = Date.now() - entry.startedAtMs;
      entry.failure = request.failure()?.errorText ?? "failed";
      this.#onSettled(entry);
    });
  }

  list(session: string, filter: NetworkFilter): NetworkEntry[] {
    const matchesStatus = filter.status === undefined ? () => true : parseStatusFilter(filter.status);
    const types = filter.types === undefined ? undefined : parseTypes(filter.types);
    return (this.#sessions.get(session)?.entries ?? []).filter((entry) =>
      (filter.urlGlob === undefined || urlGlobMatches(filter.urlGlob, entry.url))
      && (types === undefined || types.has(entry.resourceType))
      && matchesStatus(entry.status));
  }

  droppedCount(session: string): number {
    return this.#sessions.get(session)?.droppedCount ?? 0;
  }

  entry(session: string, id: string): NetworkEntry {
    const found = this.#sessions.get(session)?.entries.find((entry) => entry.id === id)
      ?? this.#sessions.get(session)?.har?.find((entry) => entry.id === id);
    if (!found) {
      throw new CommandError("bad_args", `no request ${id} in this session`, "run `patchrome network list`; old requests leave the buffer after 1000");
    }
    return found;
  }

  // Chrome keeps a body only while the page that loaded it is alive, so bodies are read on demand.
  async body(entry: NetworkEntry): Promise<Buffer> {
    const response = this.#responses.get(entry.id);
    if (!response) throw new CommandError("bad_args", `request ${entry.id} has no response`, entry.failure === undefined ? "the request is still pending" : `it failed: ${entry.failure}`);
    try {
      return await response.body();
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
      throw new CommandError("tab_gone", `body of ${entry.id} is no longer available: ${message}`, "Chrome drops bodies when the tab closes or navigates away; reload and fetch it sooner");
    }
  }

  startHar(session: string): void {
    const network = this.#sessionFor(session);
    if (network.har) throw new CommandError("bad_args", "a HAR recording is already running for this session", "run `patchrome network har stop` first");
    network.har = [];
    network.harDroppedCount = 0;
  }

  stopHar(session: string): { entries: NetworkEntry[]; droppedCount: number } {
    const network = this.#sessions.get(session);
    if (!network?.har) throw new CommandError("bad_args", "no HAR recording is running for this session", "run `patchrome network har start`");
    const result = { entries: network.har, droppedCount: network.harDroppedCount };
    network.har = undefined;
    this.#releaseResponses(result.entries.filter((entry) => !network.entries.includes(entry)));
    return result;
  }

  forget(session: string): void {
    const network = this.#sessions.get(session);
    if (!network) return;
    this.#releaseResponses([...network.entries, ...(network.har ?? [])]);
    this.#sessions.delete(session);
  }

  #append(session: string, entry: NetworkEntry): void {
    const network = this.#sessionFor(session);
    network.entries.push(entry);
    if (network.entries.length > bufferLimitPerSession) {
      const evicted = network.entries.shift();
      network.droppedCount++;
      if (evicted && !network.har?.includes(evicted)) this.#releaseResponses([evicted]);
    }
    if (network.har) {
      if (network.har.length < harLimitPerSession) network.har.push(entry);
      else network.harDroppedCount++;
    }
  }

  #releaseResponses(entries: NetworkEntry[]): void {
    for (const entry of entries) this.#responses.delete(entry.id);
  }

  #sessionFor(session: string): SessionNetwork {
    let network = this.#sessions.get(session);
    if (!network) {
      network = { entries: [], droppedCount: 0, har: undefined, harDroppedCount: 0 };
      this.#sessions.set(session, network);
    }
    return network;
  }
}

function parseTypes(raw: string): Set<string> {
  const types = raw.split(",").map((part) => part.trim());
  for (const type of types) {
    if (!(resourceTypes as readonly string[]).includes(type)) {
      throw new CommandError("bad_args", `--type ${type} is not a resource type`, `use any of ${resourceTypes.join(", ")}`);
    }
  }
  return new Set(types);
}

export function isTextual(headers: Record<string, string>): boolean {
  const contentType = headers["content-type"] ?? "";
  return /^text\/|json|javascript|xml|html|svg|x-www-form-urlencoded|graphql/i.test(contentType);
}

export function bodyExtension(headers: Record<string, string>): string {
  const contentType = headers["content-type"] ?? "";
  if (/json/i.test(contentType)) return "json";
  if (/html/i.test(contentType)) return "html";
  if (/javascript/i.test(contentType)) return "js";
  if (/css/i.test(contentType)) return "css";
  if (/svg/i.test(contentType)) return "svg";
  if (/xml/i.test(contentType)) return "xml";
  if (/png/i.test(contentType)) return "png";
  if (/jpe?g/i.test(contentType)) return "jpg";
  if (/webp/i.test(contentType)) return "webp";
  if (/^text\//i.test(contentType)) return "txt";
  return "bin";
}
