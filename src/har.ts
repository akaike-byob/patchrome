import type { NetworkEntry, RequestTiming } from "./network.ts";

export interface HarBody {
  text: string;
  encoding: "base64" | undefined;
}

interface HarHeader {
  name: string;
  value: string;
}

// HAR 1.2, the subset Chrome DevTools and har-analyzer tools read. Pending requests are left out:
// a HAR entry needs a response.
export function buildHar(entries: NetworkEntry[], bodies: Map<string, HarBody>, creatorVersion: string) {
  const pages = [...new Map(entries.map((entry) => [entry.tabId, entry])).values()].map((first) => ({
    startedDateTime: new Date(first.startedAtMs).toISOString(),
    id: first.tabId,
    title: first.tabId,
    pageTimings: {},
  }));

  return {
    log: {
      version: "1.2",
      creator: { name: "patchrome", version: creatorVersion },
      pages,
      entries: entries
        .filter((entry) => entry.state !== "pending")
        .map((entry) => {
          const timings = harTimings(entry.timing);
          const body = bodies.get(entry.id);
          const url = new URL(entry.url);
          return {
            pageref: entry.tabId,
            startedDateTime: new Date(entry.startedAtMs).toISOString(),
            time: timings.total ?? entry.durationMs ?? 0,
            request: {
              method: entry.method,
              url: entry.url,
              httpVersion: "",
              cookies: [],
              headers: toHeaders(entry.requestHeaders),
              queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
              ...(entry.postData === undefined
                ? {}
                : { postData: { mimeType: entry.requestHeaders["content-type"] ?? "", text: entry.postData } }),
              headersSize: -1,
              bodySize: entry.postData === undefined ? 0 : Buffer.byteLength(entry.postData),
            },
            response: {
              status: entry.status ?? 0,
              statusText: entry.failure ?? entry.statusText,
              httpVersion: "",
              cookies: [],
              headers: toHeaders(entry.responseHeaders),
              content: {
                size:
                  body === undefined
                    ? -1
                    : body.encoding === "base64"
                      ? Buffer.from(body.text, "base64").byteLength
                      : Buffer.byteLength(body.text),
                mimeType: entry.responseHeaders["content-type"] ?? "",
                ...(body === undefined ? {} : { text: body.text }),
                ...(body?.encoding === undefined ? {} : { encoding: body.encoding }),
              },
              redirectURL: entry.responseHeaders.location ?? "",
              headersSize: -1,
              bodySize: -1,
            },
            cache: {},
            timings: timings.phases,
            _resourceType: entry.resourceType,
          };
        }),
    },
  };
}

function toHeaders(headers: Record<string, string>): HarHeader[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

// Playwright reports phase boundaries in ms relative to startTime, with -1 for phases that did not happen.
export function harTimings(timing: RequestTiming | undefined) {
  const span = (start: number, end: number) => (start >= 0 && end >= start ? end - start : -1);
  if (!timing)
    return { phases: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 }, total: undefined };
  const phases = {
    blocked: -1,
    dns: span(timing.domainLookupStart, timing.domainLookupEnd),
    connect: span(timing.connectStart, timing.connectEnd),
    ssl: span(timing.secureConnectionStart, timing.connectEnd),
    send: 0,
    wait: Math.max(0, span(timing.requestStart, timing.responseStart)),
    receive: Math.max(0, span(timing.responseStart, timing.responseEnd)),
  };
  // HAR counts ssl inside connect, so it is not added twice.
  const total = [phases.dns, phases.connect, phases.send, phases.wait, phases.receive]
    .filter((ms) => ms > 0)
    .reduce((sum, ms) => sum + ms, 0);
  return { phases, total };
}
