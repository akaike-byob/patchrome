import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SavedSession } from "./sessions.ts";

// Session folders and saved sessions untouched this long are dropped when the daemon starts.
export const sessionRetentionMs = 7 * 24 * 60 * 60 * 1000;

const savedSessionSchema = z.object({
  name: z.string(),
  isIsolated: z.boolean(),
  label: z.string().optional(),
  currentTabId: z.string().optional(),
  tabs: z.array(z.object({ id: z.string().regex(/^t\d+$/), url: z.string() })),
});

// One bad entry drops that session, not the whole file.
const sessionsFileSchema = z.object({
  savedAtMs: z.number(),
  sessions: z.array(z.unknown()),
});

interface SessionsFile {
  savedAtMs: number;
  sessions: SavedSession[];
}

// A missing, stale or unreadable file restores nothing: restore is best-effort and never blocks a start.
export async function loadSavedSessions(path: string, nowMs: number): Promise<SavedSession[]> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return [];
  try {
    const parsed = sessionsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || nowMs - parsed.data.savedAtMs > sessionRetentionMs) return [];
    return parsed.data.sessions.flatMap((entry) => {
      const session = savedSessionSchema.safeParse(entry);
      if (!session.success) return [];
      const { label, currentTabId } = session.data;
      return [{ ...session.data, label, currentTabId }];
    });
  } catch {
    return [];
  }
}

// Writes through a temp file and a rename, so a daemon killed mid-write leaves the previous file intact.
export async function saveSessions(path: string, sessions: SavedSession[], nowMs: number): Promise<void> {
  const body: SessionsFile = { savedAtMs: nowMs, sessions };
  const partialPath = `${path}.partial`;
  await writeFile(partialPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(partialPath, path);
}

export async function pruneSessionFolders(sessionsDir: string, nowMs: number): Promise<string[]> {
  const names = await readdir(sessionsDir).catch(() => [] as string[]);
  const pruned: string[] = [];
  for (const name of names) {
    const folder = join(sessionsDir, name);
    const info = await stat(folder).catch(() => undefined);
    if (!info?.isDirectory() || nowMs - info.mtimeMs <= sessionRetentionMs) continue;
    await rm(folder, { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}
