import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HTTPS proxies with basic auth and the sites behind them. Every *.proxy.test host resolves only inside the
// proxies, so a request Chrome sends straight to the site fails DNS.

export interface TestCertificate {
  key: string;
  cert: string;
}

// One self-signed certificate covers the proxies and the sites; the in-process daemon tells Chrome and Node to
// trust it. Generated per run, so no private key sits in the repository.
export function makeTestCertificate(): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), "patchrome-proxy-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=patchrome-test",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-addext",
      "subjectAltName=DNS:localhost,DNS:*.proxy.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

export interface TargetRequest {
  host: string;
  path: string;
  clientPort: number;
}

export interface TestSites {
  requests: TargetRequest[];
  httpsPort: number;
  close: () => void;
}

// Chrome resets proxy and site connections whenever it drops a tunnel, on a rule change or a closing tab.
// Node turns a reset with no listener into an uncaught exception, which fails the run around passing tests.
const ignoreClientResets = (server: HttpsServer | ReturnType<typeof createSecureServer>): void => {
  server.on("tlsClientError", () => {});
  server.on("clientError", () => {});
  server.on("secureConnection", (socket) => socket.on("error", () => socket.destroy()));
};

const listen = async (server: Server | HttpsServer | ReturnType<typeof createSecureServer>): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

// /echo stands in for an IP echo service; every other path names the host it was asked for.
export async function startTestSites({ key, cert }: TestCertificate): Promise<TestSites> {
  const requests: TargetRequest[] = [];
  const server = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    const host = (req.headers[":authority"] ?? req.headers.host ?? "").replace(/:\d+$/, "");
    requests.push({ host, path: req.url, clientPort: req.socket.remotePort ?? 0 });
    if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ip: "203.0.113.7", country: "DE", timezone: "Europe/Berlin" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><title>${host}</title><p id="host">${host}</p>`);
  });
  ignoreClientResets(server);
  const httpsPort = await listen(server);
  return { requests, httpsPort, close: () => server.close() };
}

export interface TestProxy {
  port: number;
  // Upstream socket ports, which match the clientPort of the site requests this proxy carried.
  upstreamPorts: Set<number>;
  connects: string[];
  refusedAuth: number;
  close: () => void;
}

export async function startTestProxy(
  { key, cert }: TestCertificate,
  sites: TestSites,
  credentials: { username: string; password: string } | undefined,
): Promise<TestProxy> {
  const expected =
    credentials === undefined
      ? undefined
      : `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const proxy: TestProxy = { port: 0, upstreamPorts: new Set(), connects: [], refusedAuth: 0, close: () => {} };
  const server = createHttpsServer({ key, cert }, (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(405).end();
  });
  server.on("connect", (req: IncomingMessage, socket, head: Buffer) => {
    if (expected !== undefined && req.headers["proxy-authorization"] !== expected) {
      proxy.refusedAuth += 1;
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    proxy.connects.push(req.url ?? "");
    const upstream = connect(sites.httpsPort, "127.0.0.1", () => {
      proxy.upstreamPorts.add(upstream.localPort ?? 0);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
  });
  ignoreClientResets(server);
  proxy.port = await listen(server);
  proxy.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return proxy;
}

// A port nothing listens on: bound once, then released.
export async function closedPort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function carrierOf(proxies: TestProxy[], request: TargetRequest | undefined): TestProxy | undefined {
  return request === undefined ? undefined : proxies.find((proxy) => proxy.upstreamPorts.has(request.clientPort));
}
