import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ProfilePaths } from "./paths.ts";
import { z } from "zod";
import { CommandError } from "./protocol.ts";
import { parseJsonInput } from "./validate.ts";

export const profileModes = ["stealth", "debug"] as const;
export type ProfileMode = (typeof profileModes)[number];

export function isProfileMode(value: string): value is ProfileMode {
  return (profileModes as readonly string[]).includes(value);
}

// A profile nobody created explicitly takes its mode from its name, so `--profile debug` just works.
export function defaultModeFor(profile: string): ProfileMode {
  return profile === "debug" ? "debug" : "stealth";
}

export async function readProfileMode(paths: ProfilePaths): Promise<ProfileMode | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.profileConfigPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const { mode } = parseConfig(raw, paths.profileConfigPath);
  return mode;
}

function parseConfig(raw: string, path: string): { mode: ProfileMode } {
  return parseJsonInput(
    z.object({ mode: z.enum(profileModes) }),
    raw,
    path,
    `mode must be one of ${profileModes.join(", ")}`,
  );
}

// Mode is fixed once written: a stealth profile's cookies must never end up behind an open debugging port.
export async function fixProfileMode(
  paths: ProfilePaths,
  profile: string,
  requested: ProfileMode | undefined,
): Promise<{ mode: ProfileMode; isNew: boolean }> {
  const existing = await readProfileMode(paths);
  if (existing !== undefined) {
    if (requested !== undefined && requested !== existing) {
      throw new CommandError(
        "bad_args",
        `profile ${profile} is already a ${existing} profile`,
        `a profile's mode is fixed; create another profile for ${requested}`,
      );
    }
    return { mode: existing, isNew: false };
  }
  const mode = requested ?? defaultModeFor(profile);
  await mkdir(paths.profileDir, { recursive: true });
  await writeFile(paths.profileConfigPath, `${JSON.stringify({ mode }, null, 2)}\n`);
  return { mode, isNew: true };
}
