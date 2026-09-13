import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CommandError } from "./protocol.ts";

export interface ChromeProfile {
  // The folder inside the user data dir, such as Default or Profile 1.
  folder: string;
  // The name Chrome shows in its profile menu.
  name: string;
  email: string | undefined;
}

// Where the everyday Google Chrome keeps its profiles. PATCHROME_CHROME_USER_DATA_DIR points elsewhere,
// for Chrome Beta or a test profile.
export function chromeUserDataDirFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.PATCHROME_CHROME_USER_DATA_DIR !== undefined) return env.PATCHROME_CHROME_USER_DATA_DIR;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(home, ".config", "google-chrome");
}

export async function listChromeProfiles(userDataDir: string): Promise<{ profiles: ChromeProfile[]; lastUsedFolder: string | undefined }> {
  const raw = await readFile(join(userDataDir, "Local State"), "utf8").catch(() => {
    throw new CommandError("bad_args", `no Chrome profiles found in ${userDataDir}`, "set PATCHROME_CHROME_USER_DATA_DIR to the Chrome user data dir");
  });
  const profileState = ((JSON.parse(raw) as Record<string, unknown>).profile ?? {}) as { info_cache?: Record<string, { name?: string; user_name?: string }>; last_used?: string };
  const profiles = Object.entries(profileState.info_cache ?? {}).map(([folder, info]) => ({
    folder,
    name: info.name ?? folder,
    email: info.user_name === undefined || info.user_name === "" ? undefined : info.user_name,
  }));
  return { profiles, lastUsedFolder: profileState.last_used };
}

// Accepts what a person sees or knows: the menu name, the folder, or the signed-in email.
export function resolveChromeProfile(profiles: ChromeProfile[], from: string | undefined, lastUsedFolder: string | undefined): ChromeProfile {
  const wanted = (from ?? lastUsedFolder ?? "Default").toLowerCase();
  const matches = profiles.filter((profile) => [profile.folder, profile.name, profile.email].some((candidate) => candidate?.toLowerCase() === wanted));
  const choices = profiles.map(describeChromeProfile).join(", ");
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) throw new CommandError("bad_args", `${from} names more than one Chrome profile: ${choices}`, "pass the folder name with --from");
  throw new CommandError("bad_args", `no Chrome profile named ${from ?? wanted}`, `pass --from with one of: ${choices}`);
}

export function describeChromeProfile(profile: ChromeProfile): string {
  return `"${profile.name}" (${profile.folder}${profile.email === undefined ? "" : `, ${profile.email}`})`;
}

// A site is a host name; a pasted URL keeps only its host.
export function siteFromInput(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const host = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? new URL(trimmed).hostname : trimmed.replace(/^\./, "").split("/")[0] ?? "";
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) throw new CommandError("bad_args", `${input} is not a site`, "pass a host such as github.com");
  return host;
}

export function hostBelongsToSite(host: string, site: string): boolean {
  const bare = host.replace(/^\./, "").toLowerCase();
  return bare === site || bare.endsWith(`.${site}`);
}

// Copies only what a login lives in: the cookie jar, localStorage, and the site's own IndexedDB. The copy is
// what Chrome opens, so the everyday profile is never locked or written. Returns the site's origins that hold
// localStorage or IndexedDB.
export async function copySiteLoginStorage(profileDir: string, site: string, copyUserDataDir: string): Promise<string[]> {
  const source = (name: string) => join(profileDir, name);
  const target = join(copyUserDataDir, "Default");
  await mkdir(target, { recursive: true });
  // Chrome holds LOCK while it runs; the copy gets its own.
  const skipLock = (path: string) => basename(path) !== "LOCK";
  const origins = new Set<string>();

  for (const name of ["Cookies", "Cookies-journal"]) await cp(source(name), join(target, name)).catch(ignoreMissing);
  await cp(source("Local Storage"), join(target, "Local Storage"), { recursive: true, filter: skipLock }).catch(ignoreMissing);
  for (const origin of await localStorageOrigins(join(target, "Local Storage", "leveldb"))) {
    if (hostBelongsToSite(new URL(origin).hostname, site)) origins.add(origin);
  }

  for (const folder of await readdir(source("IndexedDB")).catch(() => [])) {
    const origin = originOfIndexedDbFolder(folder);
    if (origin === undefined || !hostBelongsToSite(new URL(origin).hostname, site)) continue;
    origins.add(origin);
    await cp(join(source("IndexedDB"), folder), join(target, "IndexedDB", folder), { recursive: true, filter: skipLock });
  }

  // Newer Chrome files IndexedDB under numbered storage buckets, listed in the QuotaManager database.
  await mkdir(join(target, "WebStorage"), { recursive: true });
  const hasQuotaManager = await cp(source("WebStorage/QuotaManager"), join(target, "WebStorage", "QuotaManager")).then(() => true, () => false);
  if (hasQuotaManager) {
    await cp(source("WebStorage/QuotaManager-journal"), join(target, "WebStorage", "QuotaManager-journal")).catch(ignoreMissing);
    for (const { bucketId, origin } of await bucketOrigins(join(target, "WebStorage", "QuotaManager"))) {
      if (!hostBelongsToSite(new URL(origin).hostname, site)) continue;
      origins.add(origin);
      await cp(source(`WebStorage/${bucketId}`), join(target, "WebStorage", String(bucketId)), { recursive: true, filter: skipLock }).catch(ignoreMissing);
    }
  }
  return [...origins].toSorted();
}

function ignoreMissing(err: unknown): void {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

// LevelDB compresses table files, but Chrome writes a META:<origin> key per origin whose text stays readable.
export async function localStorageOrigins(leveldbDir: string): Promise<string[]> {
  const origins = new Set<string>();
  for (const file of await readdir(leveldbDir).catch(() => [])) {
    if (!/\.(log|ldb)$/.test(file)) continue;
    const text = (await readFile(join(leveldbDir, file))).toString("latin1");
    for (const match of text.matchAll(/META:(https?:\/\/[a-z0-9.-]+(?::\d+)?)/g)) {
      if (match[1] !== undefined) origins.add(match[1]);
    }
  }
  return [...origins];
}

// Folders read like https_app.example.com_0.indexeddb.leveldb, where port 0 is the scheme's default.
export function originOfIndexedDbFolder(folder: string): string | undefined {
  const match = folder.match(/^(https?)_([a-z0-9.-]+)_(\d+)\.indexeddb\.leveldb$/);
  if (!match) return undefined;
  const [, scheme, host, port] = match;
  return port === "0" ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

// Partitioned keys (a site embedded in another) carry ^ markers and are left out: they are not the site's login.
// node:sqlite loads here, not at the top, because it prints an experimental warning into every CLI run.
async function bucketOrigins(quotaManagerPath: string): Promise<Array<{ bucketId: number; origin: string }>> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(quotaManagerPath, { readOnly: true });
  try {
    const rows = db.prepare("select id, storage_key from buckets").all() as Array<{ id: number; storage_key: string }>;
    return rows.flatMap((row) => {
      const match = row.storage_key.match(/^(https?:\/\/[a-z0-9.-]+(?::\d+)?)\/$/);
      return match?.[1] === undefined ? [] : [{ bucketId: row.id, origin: match[1] }];
    });
  } finally {
    db.close();
  }
}
