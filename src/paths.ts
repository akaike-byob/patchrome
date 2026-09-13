import { homedir } from "node:os";
import { join } from "node:path";

import { CommandError } from "./protocol.ts";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// macOS caps a unix socket path at 104 bytes including the terminating NUL.
const maxSocketPathBytes = 103;
const defaultIdleMs = 30 * 60 * 1000;

export function isValidName(name: string): boolean {
  return namePattern.test(name);
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHROME_HOME ?? join(homedir(), ".cache", "patchrome");
}

// One log for every profile, so a copy from one profile into another shows up in one place.
export function auditLogPathFrom(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), "copy-audit.jsonl");
}

// macOS names the app asking for Touch ID, so the approval prompt runs from a patchrome.app built here.
export function approvalBundlesDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), "approval-app");
}

export interface ProfilePaths {
  profileDir: string;
  profileConfigPath: string;
  chromeProfileDir: string;
  socketPath: string;
  lockDir: string;
  logPath: string;
  sessionsDir: string;
  savedSessionsPath: string;
}

export function profilePaths(profile: string, env: NodeJS.ProcessEnv = process.env): ProfilePaths {
  const profileDir = join(cacheRoot(env), profile);
  const socketPath = join(profileDir, "daemon.sock");
  if (Buffer.byteLength(socketPath) > maxSocketPathBytes) {
    throw new CommandError("bad_args", `socket path ${socketPath} is over ${maxSocketPathBytes} bytes`, "use a shorter --profile name or PATCHROME_HOME");
  }
  return {
    profileDir,
    profileConfigPath: join(profileDir, "profile.json"),
    chromeProfileDir: join(profileDir, "chrome-profile"),
    socketPath,
    lockDir: join(profileDir, "daemon.lock"),
    logPath: join(profileDir, "daemon.log"),
    sessionsDir: join(profileDir, "sessions"),
    savedSessionsPath: join(profileDir, "sessions.json"),
  };
}

// Session names come from agent ids and ttys. Escaping is reversible, so `a/b` and `a_b` get different folders.
export function sessionFolderName(session: string): string {
  return session.replace(/[^A-Za-z0-9.-]/g, (char) => `_${char.codePointAt(0)?.toString(16)}_`);
}

export function idleMsFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.PATCHROME_IDLE_MS;
  if (raw === undefined) return defaultIdleMs;
  const idleMs = Number(raw);
  if (!Number.isInteger(idleMs) || idleMs <= 0) {
    throw new CommandError("bad_args", `PATCHROME_IDLE_MS must be a positive integer, got ${raw}`);
  }
  return idleMs;
}
