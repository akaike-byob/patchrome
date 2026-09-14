// HTTPS proxies with basic auth and the target servers behind them, for spike 9.
// Every *.spike.test host resolves inside the proxies, so a request that skips a proxy fails DNS in Chrome.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureServer } from "node:http2";
import { connect } from "node:net";
import { join } from "node:path";

// One key signs every server, so a single --ignore-certificate-errors-spki-list entry covers proxies and targets.
export function makeCertificate(dir) {
  mkdirSync(dir, { recursive: true });
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
      "/CN=patchrome-spike",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-addext",
      "subjectAltName=DNS:localhost,DNS:*.spike.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const spkiHash = execFileSync("sh", [
    "-c",
    `openssl x509 -in "${certPath}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`,
  ])
    .toString()
    .trim();
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), spkiHash };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Chrome resets proxy and target connections whenever it drops a tunnel. Node turns a reset with no listener
// into an uncaught exception, which ends the spike halfway through its report.
const ignoreClientResets = (server) => {
  server.on("clientError", () => {});
  server.on("secureConnection", (socket) => socket.on("error", () => socket.destroy()));
  server.on("connection", (socket) => socket.on("error", () => socket.destroy()));
};

// Targets record the client port of each request, so a proxy's upstream socket port says which proxy carried it.
export async function startTargets({ key, cert }) {
  const requests = [];
  const respond = (req, res, scheme) => {
    const record = {
      scheme,
      host: req.headers.host ?? req.headers[":authority"],
      path: req.url,
      clientPort: req.socket.remotePort,
      httpVersion: req.httpVersion,
    };
    requests.push(record);
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<title>${record.host}</title><pre id="r">${JSON.stringify(record)}</pre>`);
  };
  const h2 = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => respond(req, res, "https"));
  const plain = createHttpServer((req, res) => respond(req, res, "http"));
  ignoreClientResets(h2);
  ignoreClientResets(plain);
  return {
    requests,
    httpsPort: await listen(h2),
    httpPort: await listen(plain),
    close: () => {
      h2.close();
      plain.close();
    },
  };
}

export async function startProxy({ name, key, cert, username, password, targets }) {
  const log = [];
  let expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  // An undefined password turns auth off.
  const setPassword = (next) => {
    expected = next === undefined ? undefined : `Basic ${Buffer.from(`${username}:${next}`).toString("base64")}`;
  };
  const isAuthorized = (req, socketOrRes) => {
    const header = req.headers["proxy-authorization"];
    if (expected === undefined) return true;
    log.push({
      event: "auth-check",
      method: req.method,
      url: req.url,
      hasHeader: header !== undefined,
      ok: header === expected,
    });
    if (header === expected) return true;
    const reply = `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${name}"\r\nContent-Length: 0\r\n\r\n`;
    if (socketOrRes.writeHead) {
      socketOrRes.writeHead(407, { "proxy-authenticate": `Basic realm="${name}"` }).end();
    } else {
      socketOrRes.end(reply);
    }
    return false;
  };
  const server = createHttpsServer({ key, cert }, (req, res) => {
    if (!isAuthorized(req, res)) return;
    const url = new URL(req.url);
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: targets.httpPort,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: url.host },
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("socket", (socket) =>
      socket.on("connect", () => log.push({ event: "forward", url: req.url, upstreamPort: socket.localPort })),
    );
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    if (!isAuthorized(req, socket)) return;
    const upstream = connect(targets.httpsPort, "127.0.0.1", () => {
      log.push({ event: "connect", target: req.url, upstreamPort: upstream.localPort });
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
  server.on("tlsClientError", (err) => log.push({ event: "tls-error", message: err.message }));
  ignoreClientResets(server);
  return { name, log, setPassword, port: await listen(server), close: () => server.close() };
}
