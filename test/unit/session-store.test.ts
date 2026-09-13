import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSavedSessions, pruneSessionFolders, saveSessions, sessionRetentionMs } from "../../src/session-store.ts";
import type { SavedSession } from "../../src/sessions.ts";

const saved: SavedSession[] = [
  {
    name: "agent-1",
    isIsolated: false,
    label: "checkout flow",
    currentTabId: "t2",
    tabs: [
      { id: "t1", url: "https://a.test/" },
      { id: "t2", url: "about:blank" },
    ],
  },
  { name: "agent-2", isIsolated: true, label: undefined, currentTabId: undefined, tabs: [] },
];

describe("saved sessions", () => {
  it("round-trips through sessions.json", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "patchrome-store-")), "sessions.json");
    await saveSessions(path, saved, 1_000);
    expect(await loadSavedSessions(path, 2_000)).toEqual(saved);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });

  it("restores nothing from a file older than the retention window", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "patchrome-store-")), "sessions.json");
    await saveSessions(path, saved, 1_000);
    expect(await loadSavedSessions(path, 1_000 + sessionRetentionMs + 1)).toEqual([]);
  });

  it("restores nothing from a missing or corrupt file, and skips malformed entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patchrome-store-"));
    expect(await loadSavedSessions(join(dir, "absent.json"), 0)).toEqual([]);
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    expect(await loadSavedSessions(join(dir, "corrupt.json"), 0)).toEqual([]);
    writeFileSync(
      join(dir, "mixed.json"),
      JSON.stringify({
        savedAtMs: 0,
        sessions: [saved[0], { name: "x", isIsolated: false, tabs: [{ id: "tab9", url: "" }] }],
      }),
    );
    expect(await loadSavedSessions(join(dir, "mixed.json"), 0)).toEqual([saved[0]]);
  });

  it("prunes only session folders untouched for 7 days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patchrome-prune-"));
    mkdirSync(join(dir, "old"));
    mkdirSync(join(dir, "recent"));
    const nowMs = Date.now();
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, "old"), eightDaysAgo, eightDaysAgo);
    expect(await pruneSessionFolders(dir, nowMs)).toEqual(["old"]);
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(existsSync(join(dir, "recent"))).toBe(true);
    expect(await pruneSessionFolders(join(dir, "absent"), nowMs)).toEqual([]);
  });
});
