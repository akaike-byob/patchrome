import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { CDPSession } from "patchright";

import { CommandError } from "./protocol.ts";

// Chrome writes each download under its GUID here. The folder sits inside the downloads folder, so the move to
// the real name stays on one disk, and a file never shows up half written under its real name.
const stagingDirName = ".patchrome-downloading";
// Past this many "name (n).ext" candidates the download keeps its GUID name in the staging folder.
const maxNameAttempts = 1_000;
// Filesystems without hard links: exFAT and FAT report EPERM, some network mounts ENOTSUP.
const noHardLinkCodes = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);

// Patchright saves downloads under GUID names in a temp folder it deletes when Chrome closes. Chrome's own
// "allow" keeps the name but overwrites a file already there, and an isolated context drops downloads under
// "default". So Chrome stages each download by GUID, and this moves it to a free name once it completes.
export class DownloadsFolder {
  #downloadsDir: string;
  #stagingDir: string;
  #cdp: CDPSession;
  #log: (line: string) => void;
  #suggestedNameByGuid = new Map<string, string>();
  // Moves run one at a time, so two downloads of one name in this daemon never race for the same free name.
  #moves: Promise<void> = Promise.resolve();

  // Each profile stages in its own subfolder, so daemons of two profiles can share one downloads folder.
  constructor(downloadsDir: string, chromeProfileDir: string, cdp: CDPSession, log: (line: string) => void) {
    const profile = basename(dirname(chromeProfileDir));
    const hash = createHash("sha256").update(chromeProfileDir).digest("hex").slice(0, 8);
    this.#downloadsDir = downloadsDir;
    this.#stagingDir = join(downloadsDir, stagingDirName, `${profile}-${hash}`);
    this.#cdp = cdp;
    this.#log = log;
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.#stagingDir, { recursive: true });
    } catch (err) {
      throw new CommandError(
        "setup_required",
        `cannot write the downloads folder ${this.#downloadsDir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
        "on macOS, give your terminal access to the Downloads folder, or set PATCHROME_DOWNLOADS_DIR",
      );
    }
    this.#cdp.on("Browser.downloadWillBegin", ({ guid, suggestedFilename }) => {
      this.#suggestedNameByGuid.set(guid, suggestedFilename);
    });
    this.#cdp.on("Browser.downloadProgress", ({ guid, state }) => {
      switch (state) {
        case "inProgress":
          return;
        case "completed":
          this.#moves = this.#moves.then(() => this.#moveToFreeName(guid));
          return;
        case "canceled":
          this.#suggestedNameByGuid.delete(guid);
          rm(join(this.#stagingDir, guid), { force: true }).catch((err: unknown) =>
            this.#log(`removing canceled download ${guid} failed: ${String(err)}`),
          );
          return;
      }
    });
    await this.watchContext(undefined);
  }

  // undefined is the persistent profile. The WSL relay rewrites downloadPath for the Windows Chrome.
  async watchContext(browserContextId: string | undefined): Promise<void> {
    await this.#cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.#stagingDir,
      eventsEnabled: true,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    });
  }

  async #moveToFreeName(guid: string): Promise<void> {
    const staged = join(this.#stagingDir, guid);
    const suggestedName = basename(this.#suggestedNameByGuid.get(guid) ?? "") || "download";
    this.#suggestedNameByGuid.delete(guid);
    // Chrome numbers report.tar.gz as report (1).tar.gz, not report.tar (1).gz.
    const extension = /\.tar\.[^.]+$/i.exec(suggestedName)?.[0] ?? extname(suggestedName);
    const stem = suggestedName.slice(0, suggestedName.length - extension.length);
    for (let attempt = 0; attempt < maxNameAttempts; attempt++) {
      const name = attempt === 0 ? suggestedName : `${stem} (${attempt})${extension}`;
      try {
        await placeWithoutOverwrite(staged, join(this.#downloadsDir, name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        this.#log(`download ${guid} kept at ${staged}: moving it to ${name} failed: ${String(err)}`);
        return;
      }
      await rm(staged, { force: true }).catch((err: unknown) =>
        this.#log(`download saved as ${name}, but removing ${staged} failed: ${String(err)}`),
      );
      return;
    }
    this.#log(
      `download ${guid} kept at ${staged}: ${suggestedName} and ${maxNameAttempts - 1} numbered names are taken`,
    );
  }
}

// Both calls fail with EEXIST on a taken name, where rename would overwrite the file there.
async function placeWithoutOverwrite(staged: string, target: string): Promise<void> {
  try {
    await link(staged, target);
  } catch (err) {
    if (!noHardLinkCodes.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    await copyFile(staged, target, constants.COPYFILE_EXCL);
  }
}
