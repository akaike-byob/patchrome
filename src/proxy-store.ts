import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CommandError } from "./protocol.ts";
import {
  emptyProxyConfig,
  isBuiltInRoute,
  parseProxyName,
  parseProxyServer,
  parseRulePattern,
  type ProxyConfig,
} from "./proxy-rules.ts";
import { parseJsonInput } from "./validate.ts";

// Proxies and rules sit in one file anyone may read; passwords sit in a second file only the user can read,
// so the first can be shown, logged and copied into a bug report.
export interface ProxyStorePaths {
  configPath: string;
  secretsPath: string;
}

export interface StoredProxies {
  config: ProxyConfig;
  // Proxy name to password.
  passwords: Record<string, string>;
}

const configSchema = z.strictObject({
  proxies: z.array(z.strictObject({ name: z.string(), server: z.string(), username: z.string().min(1).optional() })),
  rules: z.array(z.strictObject({ pattern: z.string(), via: z.string() })),
});
const secretsSchema = z.record(z.string(), z.string().min(1));

export async function readStoredProxies(paths: ProxyStorePaths): Promise<StoredProxies> {
  const configRaw = await readIfPresent(paths.configPath);
  const secretsRaw = await readIfPresent(paths.secretsPath);
  const hint = `fix or delete ${paths.configPath} and ${paths.secretsPath}; deleting both turns proxy rules off`;
  const config =
    configRaw === undefined ? emptyProxyConfig : parseJsonInput(configSchema, configRaw, paths.configPath, hint);
  const passwords = secretsRaw === undefined ? {} : parseJsonInput(secretsSchema, secretsRaw, paths.secretsPath, hint);
  try {
    checkConsistent(config, passwords);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError("bad_args", `${paths.configPath}: ${message}`, hint);
  }
  return { config, passwords };
}

// Every name, server and pattern is checked again on load, so a hand edit cannot slip an http proxy or a
// rule to a missing proxy past the CLI's checks.
export function checkConsistent(config: ProxyConfig, passwords: Record<string, string>): void {
  const names = new Set<string>();
  for (const proxy of config.proxies) {
    parseProxyName(proxy.name);
    if (parseProxyServer(proxy.server) !== proxy.server)
      throw new Error(`proxy ${proxy.name} server ${proxy.server} is not in https://host:port form`);
    if (names.has(proxy.name)) throw new Error(`proxy ${proxy.name} appears twice`);
    names.add(proxy.name);
    const hasPassword = passwords[proxy.name] !== undefined;
    if (proxy.username !== undefined && !hasPassword)
      throw new Error(`proxy ${proxy.name} has a username but no password`);
    if (proxy.username === undefined && hasPassword)
      throw new Error(`proxy ${proxy.name} has a password but no username`);
  }
  for (const name of Object.keys(passwords))
    if (!names.has(name)) throw new Error(`a password is stored for proxy ${name}, which does not exist`);
  const servers = new Map<string, string>();
  for (const proxy of config.proxies) {
    const other = servers.get(proxy.server);
    // Chrome names a proxy only by host and port when it asks for a password, so two names cannot share one.
    if (other !== undefined) throw new Error(`proxies ${other} and ${proxy.name} use the same server ${proxy.server}`);
    servers.set(proxy.server, proxy.name);
  }
  const patterns = new Set<string>();
  for (const rule of config.rules) {
    if (parseRulePattern(rule.pattern) !== rule.pattern)
      throw new Error(`rule pattern ${rule.pattern} is not normalized`);
    if (patterns.has(rule.pattern)) throw new Error(`rule ${rule.pattern} appears twice`);
    patterns.add(rule.pattern);
    if (!isBuiltInRoute(rule.via) && !names.has(rule.via))
      throw new Error(`rule ${rule.pattern} routes via ${rule.via}, which is not a proxy`);
  }
}

// Each file is replaced whole, so a crash mid-write leaves the old file rather than half of the new one.
export async function writeStoredProxies(paths: ProxyStorePaths, stored: StoredProxies): Promise<void> {
  await mkdir(dirname(paths.configPath), { recursive: true });
  await replaceFile(paths.secretsPath, `${JSON.stringify(stored.passwords, null, 2)}\n`, 0o600);
  await replaceFile(paths.configPath, `${JSON.stringify(stored.config, null, 2)}\n`, 0o644);
}

async function replaceFile(path: string, content: string, mode: number): Promise<void> {
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, content, { mode });
  // writeFile applies mode only to a file it creates, and the umask may have narrowed or widened it.
  await chmod(staging, mode);
  await rename(staging, path);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
