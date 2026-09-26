import { currentBuildId, isNewerBuild, moduleExtension } from "./build-id.ts";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { idleMsFrom, isTestHeadlessFrom, profilePaths, type ProfilePaths } from "./paths.ts";
import {
  CommandError,
  type CommandArgs,
  type CommandName,
  type DaemonResponse,
  type DaemonStreamLine,
} from "./protocol.ts";

const daemonStartTimeoutMs = 30_000;
// An outdated daemon saves its sessions and closes Chrome before it exits; a new Chrome on the same profile
// before then would hand its window to the old one and quit.
const daemonExitTimeoutMs = 30_000;
const daemonControlTimeoutMs = 10_000;
const lockPollMs = 100;
// A lock whose owner pid is dead is stale at once. Without a pid file yet, the owner may be between
// mkdir and writing it, so only a lock older than this is stale.
const ownerlessLockAgeMs = 5_000;

export interface CommandRequest {
  session: string;
  command: CommandName;
  args: CommandArgs;
  timeoutMs: number;
  // The words the caller typed, which the daemon keeps in the session's history.
  argv: string[];
  shouldStartDaemon: boolean;
  onStream?: (stream: DaemonStreamLine["stream"]) => void;
}

interface PendingRequest {
  resolve: (response: DaemonResponse) => void;
  reject: (err: CommandError) => void;
  onStream: (stream: DaemonStreamLine["stream"]) => void;
  timer: NodeJS.Timeout;
  // A socket closed on purpose closes after its replacement opened; it fails only its own requests.
  socket: Socket;
}

// One socket to one profile's daemon, carrying any number of requests told apart by id. A CLI call sends one
// request; `pipe` and the library send many over the same socket, so they pay for Node and the daemon
// handshake once. When the daemon goes away, pending requests fail and the next request reconnects,
// starting a daemon if it may.
export class DaemonConnection {
  readonly #profile: string;
  readonly #env: NodeJS.ProcessEnv;
  #socket: Promise<Socket> | undefined;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #replacingDaemon: Promise<boolean> | undefined;

  constructor(profile: string, env: NodeJS.ProcessEnv = process.env) {
    idleMsFrom(env);
    isTestHeadlessFrom(env);
    this.#profile = profile;
    this.#env = env;
  }

  async request(request: CommandRequest): Promise<DaemonResponse> {
    const response = await this.#send(request);
    if (response.ok || response.error.code !== "daemon_outdated") return response;
    // Requests in flight together share one replacement.
    this.#replacingDaemon ??= this.#replaceOutdatedDaemon(request.session).finally(() => {
      this.#replacingDaemon = undefined;
    });
    return (await this.#replacingDaemon) ? this.#send(request) : response;
  }

  // Stops a daemon older than this CLI and waits for it to exit. Other sessions lose their in-flight commands;
  // their tabs come back on their next command. Holding the start lock meanwhile keeps other CLIs from
  // launching a Chrome before the old one has closed. Returns whether a retry can reach a current daemon.
  async #replaceOutdatedDaemon(session: string): Promise<boolean> {
    const buildId = currentBuildId(this.#env);
    const outdated = await this.#runningDaemon(session);
    if (outdated === undefined || !isNewerBuild(buildId, outdated.buildId)) return false;
    const paths = profilePaths(this.#profile, this.#env);
    await acquireLock(paths.lockDir);
    try {
      // Another CLI may have replaced it while this one waited for the lock.
      this.close();
      const running = await this.#runningDaemon(session);
      if (running === undefined || running.buildId === buildId) return true;
      if (!isNewerBuild(buildId, running.buildId)) return false;
      await this.#send(daemonControl(session, "daemon-stop"));
      this.close();
      await waitForExit(running.pid);
      return true;
    } finally {
      await rm(paths.lockDir, { recursive: true, force: true });
    }
  }

  async #runningDaemon(session: string): Promise<{ buildId: string; pid: number } | undefined> {
    try {
      const status = await this.#send(daemonControl(session, "daemon-status"));
      if (!status.ok) return undefined;
      const { buildId, pid } = status.data.fields;
      return typeof buildId === "string" && typeof pid === "number" ? { buildId, pid } : undefined;
    } catch (err) {
      if (err instanceof CommandError && err.code === "daemon_unreachable") return undefined;
      throw err;
    }
  }

  async #send(request: CommandRequest): Promise<DaemonResponse> {
    const socket = await this.#connect(request.shouldStartDaemon);
    const id = this.#nextId++;
    const deadlineMs = request.timeoutMs + daemonStartTimeoutMs;
    const answered = new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#unrefWhenIdle(socket);
        reject(new CommandError("daemon_unreachable", `daemon did not answer within ${deadlineMs} ms`));
      }, deadlineMs);
      this.#pending.set(id, { resolve, reject, onStream: request.onStream ?? (() => {}), timer, socket });
    });
    socket.ref();
    socket.write(
      `${JSON.stringify({
        id,
        session: request.session,
        command: request.command,
        args: request.args,
        timeoutMs: request.timeoutMs,
        argv: request.argv,
        buildId: currentBuildId(this.#env),
      })}\n`,
    );
    return answered;
  }

  close(): void {
    void this.#socket?.then(
      (socket) => socket.end(),
      () => {},
    );
    this.#socket = undefined;
  }

  #connect(shouldStartDaemon: boolean): Promise<Socket> {
    if (this.#socket !== undefined) return this.#socket;
    const connecting = (async () => {
      const paths = profilePaths(this.#profile, this.#env);
      const existing = await tryConnect(paths.socketPath);
      if (existing) return this.#attach(existing);
      if (!shouldStartDaemon)
        throw new CommandError("daemon_unreachable", `no daemon running for profile ${this.#profile}`);
      return this.#attach(await startDaemonAndConnect(this.#profile, paths, this.#env));
    })();
    this.#socket = connecting;
    // A failed connect is not cached: the next request tries again.
    connecting.catch(() => {
      if (this.#socket === connecting) this.#socket = undefined;
    });
    return connecting;
  }

  #attach(socket: Socket): Socket {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const message = JSON.parse(buffer.slice(0, newlineIndex)) as DaemonResponse | DaemonStreamLine;
        buffer = buffer.slice(newlineIndex + 1);
        const pending = this.#pending.get(message.id);
        if (pending !== undefined) {
          if ("stream" in message) {
            pending.onStream(message.stream);
          } else {
            clearTimeout(pending.timer);
            this.#pending.delete(message.id);
            pending.resolve(message);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
      this.#unrefWhenIdle(socket);
    });
    const fail = (reason: string) => {
      const connecting = this.#socket;
      void connecting?.then(
        (current) => {
          if (current === socket && this.#socket === connecting) this.#socket = undefined;
        },
        () => {},
      );
      for (const [id, pending] of this.#pending) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new CommandError("daemon_unreachable", reason));
      }
    };
    socket.on("error", (err) => fail(err.message));
    socket.on("close", () => fail("daemon closed the connection without answering"));
    return socket;
  }

  // An idle socket must not keep a script's process alive after its last request.
  #unrefWhenIdle(socket: Socket): void {
    if (this.#pending.size === 0) socket.unref();
  }
}

function daemonControl(session: string, command: "daemon-status" | "daemon-stop"): CommandRequest {
  return { session, command, args: {}, timeoutMs: daemonControlTimeoutMs, argv: [], shouldStartDaemon: false };
}

async function waitForExit(pid: number): Promise<void> {
  const deadlineMs = Date.now() + daemonExitTimeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadlineMs)
      throw new CommandError(
        "daemon_unreachable",
        `the outdated daemon, pid ${pid}, did not exit within ${daemonExitTimeoutMs} ms`,
        "see `patchrome daemon logs`",
      );
    await sleep(lockPollMs);
  }
}

async function acquireLock(lockDir: string): Promise<void> {
  const deadlineMs = Date.now() + daemonStartTimeoutMs;
  while (!(await tryAcquireLock(lockDir))) {
    if (Date.now() > deadlineMs)
      throw new CommandError("daemon_unreachable", `${lockDir} stayed locked for ${daemonStartTimeoutMs} ms`);
    await clearStaleLock(lockDir);
    await sleep(lockPollMs);
  }
}

// Three agents starting at once must end with one daemon. `mkdir` is atomic, so exactly one starter
// wins the lock and spawns; the rest poll the socket until the winner's daemon answers.
async function startDaemonAndConnect(profile: string, paths: ProfilePaths, env: NodeJS.ProcessEnv): Promise<Socket> {
  await mkdir(paths.profileDir, { recursive: true });
  const deadlineMs = Date.now() + daemonStartTimeoutMs;
  while (Date.now() < deadlineMs) {
    const socket = await tryConnect(paths.socketPath);
    if (socket) return socket;
    if (await tryAcquireLock(paths.lockDir)) {
      const existing = await tryConnect(paths.socketPath);
      if (existing) {
        await rm(paths.lockDir, { recursive: true, force: true });
        return existing;
      }
      await spawnDaemon(profile, paths, env);
    } else {
      await clearStaleLock(paths.lockDir);
    }
    await sleep(lockPollMs);
  }
  const logTail = (await readFile(paths.logPath, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" | ");
  throw new CommandError(
    "daemon_unreachable",
    `daemon for profile ${profile} did not start within ${daemonStartTimeoutMs} ms`,
    logTail === "" ? `see ${paths.logPath}` : `last log lines: ${logTail}`,
  );
}

async function tryAcquireLock(lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  await writeFile(join(lockDir, "owner.pid"), String(process.pid));
  return true;
}

async function clearStaleLock(lockDir: string): Promise<void> {
  try {
    const ownerPid = Number(await readFile(join(lockDir, "owner.pid"), "utf8").catch(() => "0"));
    if (ownerPid > 0) {
      if (isAlive(ownerPid)) return;
    } else {
      const { mtimeMs } = await stat(lockDir);
      if (Date.now() - mtimeMs < ownerlessLockAgeMs) return;
    }
    await rm(lockDir, { recursive: true, force: true });
  } catch {
    // The lock vanished between checks, which means its owner finished.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnDaemon(profile: string, paths: ProfilePaths, env: NodeJS.ProcessEnv): Promise<void> {
  const cliPath = fileURLToPath(new URL(`./cli${moduleExtension}`, import.meta.url));
  const logFile = await open(paths.logPath, "a");
  const child = spawn(process.execPath, [cliPath, "__daemon", "--profile", profile], {
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd],
    env,
  });
  // The lock passes to the daemon, which removes it once listening. Its pid replaces ours as owner.
  await writeFile(join(paths.lockDir, "owner.pid"), String(child.pid ?? 0));
  child.unref();
  await logFile.close();
}

function tryConnect(socketPath: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => resolve(undefined));
  });
}
