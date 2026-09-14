import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { CommandError } from "./protocol.ts";
import { hostPortOf, type ProxyServer } from "./proxy-rules.ts";

// Returns the caller's public IP, country and timezone as JSON. PATCHROME_IP_ECHO_URL replaces it.
export const defaultIpEchoUrl = "https://ipinfo.io/json";

export interface ExitAddress {
  ip: string | undefined;
  country: string | undefined;
  timeZone: string | undefined;
}

export interface ExitCheckOptions {
  echoUrl: string;
  proxy: { server: ProxyServer; password: string | undefined } | undefined;
  timeoutMs: number;
  // Certificates to trust instead of the system's, for tests that run on self-signed ones.
  trustedCertificates?: string[];
}

export function parseIpEchoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommandError("bad_args", `PATCHROME_IP_ECHO_URL ${raw} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new CommandError("bad_args", `PATCHROME_IP_ECHO_URL must be http or https, got ${url.protocol}`);
  return url.href;
}

// The daemon asks from Node, not Chrome: an exit address check needs the proxy's IP, not a page load, and
// sending it through Chrome would mean pointing a rule at the echo service for a moment, for every session.
export async function checkExitAddress(options: ExitCheckOptions): Promise<ExitAddress> {
  const echo = new URL(options.echoUrl);
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const socket = options.proxy === undefined ? undefined : await openTunnel(options, echo, deadline);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const makeRequest = echo.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = makeRequest(echo, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: deadline,
      ...(options.trustedCertificates === undefined ? {} : { ca: options.trustedCertificates }),
      ...(socket === undefined
        ? {}
        : echo.protocol === "https:"
          ? {
              createConnection: () => tlsConnect({ socket, servername: serverNameOf(echo.hostname), ...caOf(options) }),
            }
          : { createConnection: () => socket }),
    });
    outgoing.on("response", resolve);
    outgoing.on("error", reject);
    outgoing.end();
  }).catch((err: unknown) => {
    throw exitCheckError(options, err);
  });
  const body = await readBody(response);
  if (response.statusCode !== 200)
    throw new CommandError(
      "navigation_failed",
      `${echo.host} answered ${response.statusCode} to the exit address check`,
    );
  return parseExitAddress(body);
}

export function parseExitAddress(body: string): ExitAddress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ip: body.trim().split(/\s+/)[0] || undefined, country: undefined, timeZone: undefined };
  }
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const text = (...names: string[]) => {
    for (const name of names) if (typeof fields[name] === "string" && fields[name] !== "") return fields[name];
    return undefined;
  };
  return { ip: text("ip", "query"), country: text("country", "countryCode"), timeZone: text("timezone", "timeZone") };
}

// CONNECT through TLS to the proxy, the way Chrome reaches an HTTPS proxy.
async function openTunnel(options: ExitCheckOptions, echo: URL, deadline: AbortSignal): Promise<TLSSocket> {
  const proxy = options.proxy;
  if (proxy === undefined) throw new Error("openTunnel needs a proxy");
  const server = new URL(proxy.server.server);
  const target = `${echo.hostname}:${echo.port || (echo.protocol === "https:" ? "443" : "80")}`;
  const socket = tlsConnect({
    host: server.hostname.replace(/^\[|\]$/g, ""),
    port: Number(server.port),
    servername: serverNameOf(server.hostname),
    ...caOf(options),
  });
  const onAbort = () => socket.destroy(new Error(`timed out after ${options.timeoutMs} ms`));
  deadline.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    const authorization =
      proxy.server.username === undefined || proxy.password === undefined
        ? ""
        : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.server.username}:${proxy.password}`).toString("base64")}\r\n`;
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`);
    const status = await readConnectStatus(socket);
    if (status === 407)
      throw new CommandError(
        "proxy_auth_failed",
        `${hostPortOf(proxy.server.server)} refused the credentials for proxy ${proxy.server.name}`,
        `check the username and password with the provider, then \`patchrome proxy add ${proxy.server.name} ...\` again`,
      );
    if (status !== 200)
      throw new CommandError(
        "proxy_unreachable",
        `proxy ${proxy.server.name} answered ${status} to CONNECT ${target}`,
        "the proxy may not allow this destination or port",
      );
    return socket;
  } catch (err) {
    socket.destroy();
    throw exitCheckError(options, err);
  } finally {
    deadline.removeEventListener("abort", onAbort);
  }
}

function readConnectStatus(socket: TLSSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      socket.off("error", reject);
      socket.pause();
      // Anything past the head belongs to the tunnel.
      const rest = Buffer.from(head.slice(end + 4), "latin1");
      if (rest.length > 0) socket.unshift(rest);
      resolve(Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("proxy closed the connection before answering CONNECT")));
  });
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function exitCheckError(options: ExitCheckOptions, err: unknown): CommandError {
  if (err instanceof CommandError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (options.proxy === undefined)
    return new CommandError(
      "navigation_failed",
      `exit address check to ${new URL(options.echoUrl).host} failed: ${message}`,
    );
  return new CommandError(
    "proxy_unreachable",
    `proxy ${options.proxy.server.name} (${hostPortOf(options.proxy.server.server)}) failed: ${message}`,
    "check the proxy server address and port, and that it serves https",
  );
}

function serverNameOf(hostname: string): string | undefined {
  // TLS SNI takes a host name, never an IP address.
  return isIP(hostname.replace(/^\[|\]$/g, "")) === 0 ? hostname : undefined;
}

function caOf(options: ExitCheckOptions): { ca?: string[] } {
  return options.trustedCertificates === undefined ? {} : { ca: options.trustedCertificates };
}
