import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { currentBuildId } from "./build-id.ts";
import { CopyGuard, type HostPrompts } from "./copy-guard.ts";
import { detectHostPlatform } from "./host-platform.ts";
import { hostPromptsFor } from "./host-prompts.ts";
import { restoreSession, runCommand, type CommandContext } from "./commands.ts";
import { PatchrightEngine, type BrowserEngine } from "./engine.ts";
import { PageDiagnostics } from "./diagnostics.ts";
import { SessionEvents } from "./events.ts";
import { NetworkLog } from "./network.ts";
import { appendHistoryStep, historyFileName, isReplayable, replayStep } from "./history.ts";
import { approvalBundlesDirFrom, auditLogPathFrom, idleMsFrom, profilePaths, sessionFolderName } from "./paths.ts";
import { fixProfileMode } from "./profile-mode.ts";
import { CommandError, isCommandName, type CommandData, type DaemonRequest, type DaemonResponse, type DaemonStreamLine } from "./protocol.ts";
import { RouteTable } from "./routes.ts";
import { loadSavedSessions, pruneSessionFolders, saveSessions } from "./session-store.ts";
import { SessionRegistry, type SavedSession } from "./sessions.ts";
import { tabGroupColorFor, tabGroupTitleFor } from "./tab-groups.ts";
import { parseJsonInput } from "./validate.ts";

// Integration tests run a daemon inside the test process, where code answers the copy prompt. Neither option
// can be set from outside: the `__daemon` entrypoint passes none, so a spawned daemon always asks a person.
export interface DaemonOptions {
  prompts?: HostPrompts;
  exitProcess?: (code: number) => void;
}

export async function runDaemon(profile: string, env: NodeJS.ProcessEnv = process.env, options: DaemonOptions = {}): Promise<void> {
  const paths = profilePaths(profile, env);
  const idleMs = idleMsFrom(env);
  const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

  await mkdir(paths.chromeProfileDir, { recursive: true });
  await rm(paths.socketPath, { force: true });
  const { mode } = await fixProfileMode(paths, profile, undefined);
  const pruned = await pruneSessionFolders(paths.sessionsDir, Date.now());
  if (pruned.length > 0) log(`pruned ${pruned.length} session folders older than 7 days`);
  // Sessions wait here until their first command, so a restart does not reload every site at once.
  const awaitingRestore = new Map<string, SavedSession>((await loadSavedSessions(paths.savedSessionsPath, Date.now())).map((saved) => [saved.name, saved]));
  let isSavingSessions = true;
  let saveTimer: NodeJS.Timeout | undefined;
  const saveSessionsNow = async () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const live = registry.savedSessions();
    const liveNames = new Set(live.map((saved) => saved.name));
    const waiting = [...awaitingRestore.values()].filter((saved) => !liveNames.has(saved.name));
    await saveSessions(paths.savedSessionsPath, [...live, ...waiting], Date.now()).catch((err: unknown) => log(`saving sessions.json failed: ${String(err)}`));
  };
  const scheduleSessionsSave = () => {
    if (!isSavingSessions || saveTimer !== undefined) return;
    saveTimer = setTimeout(() => void saveSessionsNow(), 100);
  };

  const engine: BrowserEngine = new PatchrightEngine();
  const events = new SessionEvents();
  const network = new NetworkLog((entry) => events.publish(entry.session, { kind: "response", tabId: entry.tabId, entry, atMs: Date.now() }));
  const routes = new RouteTable();
  const diagnostics = new PageDiagnostics((tab, pageError) => events.publish(tab.session, { kind: "error", tabId: tab.id, pageError, atMs: Date.now() }));
  const consoleCaptureByTab = new WeakMap<object, Promise<void>>();
  // One regroup at a time per session, so two tabs opened together join one group instead of starting two.
  // A tab group is a label for people watching the browser, so a failure is logged and never fails a command.
  // Isolated sessions stay ungrouped: Chrome keeps each CDP browser context out of reach of extensions, and
  // chrome.tabs.get answers "No tab with id" for their tabs.
  const regroupQueues = new Map<string, Promise<void>>();
  const regroupTabs = (session: string): Promise<void> => {
    const regrouped = (regroupQueues.get(session) ?? Promise.resolve()).then(async () => {
      await launched;
      const pages = registry.openTabsOf(session).map((tab) => tab.page);
      if (pages.length === 0 || registry.browserContextOf(session) !== undefined) return;
      await engine.groupTabs(pages, tabGroupTitleFor(session, registry.labelOf(session)), tabGroupColorFor(session));
    }).catch((err: unknown) => { log(`${session} tab grouping failed: ${String(err).split("\n")[0]}`); });
    regroupQueues.set(session, regrouped);
    void regrouped.then(() => {
      if (regroupQueues.get(session) === regrouped) regroupQueues.delete(session);
    });
    return regrouped;
  };
  const registry = new SessionRegistry((tab) => {
    network.record(tab);
    routes.track(tab);
    tab.page.on("framenavigated", (frame) => {
      if (frame === tab.page.mainFrame()) events.publish(tab.session, { kind: "navigation", tabId: tab.id, url: frame.url(), atMs: Date.now() });
    });
    tab.page.on("load", () => events.publish(tab.session, { kind: "load", tabId: tab.id, url: tab.page.url(), atMs: Date.now() }));
    void regroupTabs(tab.session);
    switch (mode) {
      case "stealth":
        break;
      case "debug":
        consoleCaptureByTab.set(tab, engine.openCdpSession(tab.page)
          .then((cdp) => diagnostics.record(tab, cdp))
          .catch((err: unknown) => { log(`console capture failed for ${tab.id}: ${String(err)}`); }));
        break;
    }
  }, scheduleSessionsSave);
  registry.reserveTabIds([...awaitingRestore.values()].flatMap((saved) => saved.tabs.map((tab) => tab.id)));
  const buildId = currentBuildId();
  const version = buildId.split("+")[0] ?? buildId;
  const sessionQueues = new Map<string, Promise<unknown>>();
  let idleTimer: NodeJS.Timeout | undefined;
  // The idle clock runs only while no request is in flight, so a slow Chrome launch or a long wait is never cut off.
  let inFlightRequests = 0;
  let isShuttingDown = false;

  const server = createServer((socket) => handleConnection(socket));

  const shutdown = async (reason: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log(`shutting down: ${reason}`);
    clearTimeout(idleTimer);
    server.close();
    await rm(paths.socketPath, { force: true });
    // Closing Chrome closes every page, which would save empty sessions over the ones to restore.
    await saveSessionsNow();
    isSavingSessions = false;
    await engine.close().catch((err) => log(`engine close failed: ${String(err)}`));
    (options.exitProcess ?? process.exit)(0);
  };

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    // A request can arrive while startup is still awaiting after listen, before startup arms the timer.
    if (inFlightRequests > 0) return;
    idleTimer = setTimeout(() => void shutdown(`idle for ${idleMs} ms`), idleMs);
  };

  const ctx: CommandContext = {
    engine,
    registry,
    network,
    routes,
    diagnostics,
    events,
    mode,
    trace: { owner: undefined },
    consoleCaptureReady: (tab) => consoleCaptureByTab.get(tab) ?? Promise.resolve(),
    version,
    buildId,
    sessionsDir: paths.sessionsDir,
    profile,
    startedAtMs: Date.now(),
    requestShutdown: () => setImmediate(() => void shutdown("daemon stop")),
    regroupTabs,
    savedSessionNames: () => [...awaitingRestore.keys()].filter((name) => !registry.hasSession(name)),
    forgetSavedSession: (name) => {
      awaitingRestore.delete(name);
      scheduleSessionsSave();
    },
    copyGuard: new CopyGuard({ prompts: options.prompts ?? hostPromptsFor(detectHostPlatform(), log, approvalBundlesDirFrom(env)), auditLogPath: auditLogPathFrom(env), profile, log }),
  };

  // Listening before Chrome is up lets concurrent starters connect at once; requests wait on launch.
  const launched = engine.launch(paths.chromeProfileDir, mode);
  engine.onClosed(() => void shutdown("browser closed"));
  launched.catch((err) => {
    log(`browser launch failed: ${String(err)}`);
    void shutdown("launch failure");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => resolve());
  });
  await chmod(paths.socketPath, 0o600);
  // The starter's lock is released once the socket answers, so later starters connect instead of spawning.
  await rm(paths.lockDir, { recursive: true, force: true });
  log(`listening on ${paths.socketPath}, pid ${process.pid}, ${mode} profile`);
  resetIdleTimer();

  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));

  // A connection carries one request from the CLI, or many from `pipe` and the library.
  function handleConnection(socket: Socket) {
    const disconnected = new AbortController();
    socket.once("close", () => disconnected.abort());
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      inFlightRequests += 1;
      clearTimeout(idleTimer);
      void respond(socket, line, disconnected.signal).finally(() => {
        inFlightRequests -= 1;
        resetIdleTimer();
      });
    });
    socket.on("error", () => {});
  }

  async function recordHistory(request: DaemonRequest, data: CommandData) {
    if (request.argv === undefined || !isReplayable(request.command, request.args)) return;
    const path = join(paths.sessionsDir, sessionFolderName(request.session), historyFileName);
    await appendHistoryStep(path, replayStep(request.command, request.argv, data.replay, Date.now()))
      .catch((err: unknown) => log(`${request.session} history write failed: ${String(err)}`));
  }

  // A follow runs until its timeout or until the client disconnects, and outside the session queue, so
  // the same session can keep browsing while it streams.
  function isStreaming(request: DaemonRequest): boolean {
    return (request.command === "console" && request.args.follow === true) || request.command === "watch";
  }

  async function restoreIfSaved(request: DaemonRequest) {
    const saved = awaitingRestore.get(request.session);
    if (saved === undefined) return;
    if (request.command === "daemon-status" || request.command === "daemon-stop") return;
    if (request.command === "session-close" && request.args.pattern === undefined) {
      awaitingRestore.delete(request.session);
      scheduleSessionsSave();
      return;
    }
    awaitingRestore.delete(request.session);
    const { restored, dropped } = await restoreSession(ctx, saved, request.timeoutMs);
    log(`${request.session} restored tabs ${restored.join(" ") || "none"}${dropped.length > 0 ? `, dropped ${dropped.join(" ")}` : ""}`);
  }

  async function respond(socket: Socket, line: string, disconnected: AbortSignal) {
    let request: DaemonRequest;
    try {
      request = parseRequest(line);
    } catch (err) {
      return send(socket, { id: -1, ok: false, error: toCommandError(err).toBody() });
    }

    // status and stop still work, so an outdated daemon can be inspected and replaced.
    if (request.buildId !== buildId && request.command !== "daemon-status" && request.command !== "daemon-stop") {
      return send(socket, {
        id: request.id,
        ok: false,
        error: new CommandError(
          "daemon_outdated",
          `the running daemon is patchrome build ${buildId}, this CLI is ${request.buildId}`,
          "run `patchrome daemon stop` once no other session is browsing; the next command starts a current daemon",
        ).toBody(),
      });
    }

    const call = {
      ...request,
      emit: (stream: DaemonStreamLine["stream"]) => send(socket, { id: request.id, stream }),
      disconnected,
    };

    if (isStreaming(request)) {
      try {
        await launched;
        const { lines, fields } = await runCommand(ctx, call);
        return send(socket, { id: request.id, ok: true, data: { lines, fields } });
      } catch (err) {
        return send(socket, { id: request.id, ok: false, error: toCommandError(err).toBody() });
      }
    }

    // Commands from one session run in order; different sessions run concurrently.
    const previous = sessionQueues.get(request.session) ?? Promise.resolve();
    const current = previous.then(async (): Promise<DaemonResponse> => {
      try {
        await launched;
        await restoreIfSaved(request);
        const { lines, fields, replay } = await runCommand(ctx, call);
        await recordHistory(request, { lines, fields, replay });
        return { id: request.id, ok: true, data: { lines, fields } };
      } catch (err) {
        const error = toCommandError(err);
        log(`${request.session} ${request.command} failed: ${error.code} ${error.message}`);
        return { id: request.id, ok: false, error: error.toBody() };
      }
    });
    const settled = current.catch(() => {});
    sessionQueues.set(request.session, settled);
    void settled.then(() => {
      if (sessionQueues.get(request.session) === settled) sessionQueues.delete(request.session);
    });
    send(socket, await current);
  }
}

function send(socket: Socket, response: DaemonResponse | DaemonStreamLine) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

const requestSchema = z.object({
  id: z.number(),
  session: z.string().min(1),
  command: z.string().refine(isCommandName, { error: (issue) => `unknown command ${String(issue.input)}` }),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])),
  timeoutMs: z.number().positive(),
  argv: z.array(z.string()).optional(),
  buildId: z.string(),
});

function parseRequest(line: string): DaemonRequest {
  return parseJsonInput(requestSchema, line, "request") as DaemonRequest;
}

function toCommandError(err: unknown): CommandError {
  if (err instanceof CommandError) return err;
  if (err instanceof SyntaxError) return new CommandError("bad_args", `malformed request: ${err.message}`);
  const message = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
  if (err instanceof Error && err.name === "TimeoutError") return new CommandError("timeout", message);
  return new CommandError("bad_args", message);
}
