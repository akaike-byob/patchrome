import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromeUserDataDirFrom } from "./chrome-profiles.ts";
import { cliOptions } from "./cli-options.ts";
import { DaemonConnection } from "./client.ts";
import { zshCompletionScript } from "./completions.ts";
import { auditLine, readAuditLog } from "./copy-guard.ts";
import { auditLogPathFrom, isValidName, profilePaths, sessionFolderName } from "./paths.ts";
import { fixProfileMode, isProfileMode, profileModes } from "./profile-mode.ts";
import {
  CommandError,
  exitCodeFor,
  type CommandArgs,
  type CommandData,
  type CommandName,
  type DaemonResponse,
} from "./protocol.ts";
import { lookupProcess, resolveSessionName } from "./session-name.ts";
import {
  clearHistory,
  formatHistory,
  historyFileName,
  historyFormats,
  isHistoryFormat,
  readHistory,
  type HistoryFormat,
} from "./history.ts";
import { runPipe } from "./pipe.ts";
import { CommandRunner, toCommandError } from "./runner.ts";

const usage = `usage: patchrome [--profile <name>] [--session <name>] [--json] [--timeout-ms <n>] <command>

an element is a ref from the latest snapshot (@e12), or a locator that works on every run:
  --role <role> [--name <name>] [--exact] | --text <text> [--exact] | --label <text> [--exact] | --selector <css>
  with [--nth <n>] to pick a match other than the first, and [--frame <iframe-css>]
values print inline up to 2 KB and go to a file past that; --inline or --out <file> fixes the shape

tabs and navigation
  open [url] [--wait load|domcontentloaded|networkidle] [--isolated]
  tabs [--all]
  switch <tab>
  close [tab]
  goto <url> [--wait ...]

reading
  snapshot [--inline | --out <file>]
  screenshot [--full] [<element>] [--out <file>]
  text [<element>] [--inline | --out <file>]
  eval <js> [--main-world] [--inline | --out <file>]
  extract <schema.json|inline-json> [<element>] [--inline | --out <file>]

waiting and watching
  wait <element> | --url <glob> | --title <text> [--gone]
  wait --load load|domcontentloaded|networkidle
  watch [--events navigation,load,response,console,error] [--url <glob>] [--count <n>]

acting
  click <ref> | <element> | --at <x>,<y>
  fill <ref> <text> | fill <element> <text>
  type <text>
  press <key>
  challenge [--handoff]

network
  network list [--url <glob>] [--type xhr,fetch] [--status 4xx] [--inline | --out <file>]
  network get <id> | --url <glob> [--body] [--inline | --out <file>]
  network har start|stop [--out <file>]
  route block <glob>
  route mock <glob> <file>
  route list|clear

state
  login <url> [--until <url-glob>]
  cookies [--domain <domain>] [--inline | --out <file>]
  state save <file>
  state load <file>
  state import <site> [--from <chrome-profile>]
  state export <site> <file>

scripting
  pipe [--bail]                          JSON requests on stdin, one JSON response per line on stdout
  session history [--format sh|jsonl] [--out <file>]
  session history clear

debug profile only
  console [--level debug|info|warning|error] [--follow]
  errors
  trace start|stop [--out <file>]
  cdp <Domain.method> [params-json]
  cdp help [Domain|Domain.method]
  devtools-url

lifecycle
  profile create <name> --mode stealth|debug
  session
  session label <text>
  session close [session|pattern]
  sessions [pattern]
  daemon status|stop|logs
  audit [--count <n>]
  completions zsh`;

interface ParsedCli {
  profile: string;
  session: string;
  isJson: boolean;
  timeoutMs: number;
  command: CommandName;
  args: CommandArgs;
  shouldStartDaemon: boolean;
}

export type LocalAction =
  | { kind: "logs"; profile: string; isJson: boolean }
  | { kind: "audit"; count: number; isJson: boolean }
  | { kind: "create-profile"; profile: string; mode: string; isJson: boolean }
  | { kind: "completions"; shell: "zsh" }
  | {
      kind: "history";
      profile: string;
      session: string;
      format: HistoryFormat;
      out: string | undefined;
      isClear: boolean;
      isJson: boolean;
    }
  | { kind: "pipe"; profile: string; session: string; isBail: boolean };

export function parseCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  sessionFallback: () => string,
): ParsedCli | LocalAction {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: cliOptions,
  });

  const profile = values.profile ?? env.PATCHROME_PROFILE ?? "stealth";
  if (!isValidName(profile))
    throw new CommandError("bad_args", `invalid profile name ${profile}`, "use letters, digits, dot, dash, underscore");
  const [verb, ...rest] = positionals;
  // A person signs in by hand, which takes minutes, not the 30 s an agent command gets.
  // An import starts a second Chrome and copies every IndexedDB record of the site. Imports, loads and exports
  // also wait up to a minute for the person to approve the copy.
  const defaultTimeoutMs =
    verb === "login" ||
    verb === "watch" ||
    (verb === "challenge" && values.handoff) ||
    (verb === "console" && values.follow)
      ? 600_000
      : verb === "state" && (positionals[1] === "import" || positionals[1] === "load" || positionals[1] === "export")
        ? 120_000
        : 30_000;
  const timeoutMs = values["timeout-ms"] === undefined ? defaultTimeoutMs : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new CommandError("bad_args", `--timeout-ms must be a positive integer, got ${values["timeout-ms"]}`);

  const need = (index: number, name: string): string => {
    const value = rest[index];
    if (value === undefined)
      throw new CommandError(
        "bad_args",
        `${verb} needs <${name}>`,
        usage.split("\n").find((line) => line.trim().startsWith(`${verb} `)),
      );
    return value;
  };
  const out = values.out === undefined ? undefined : resolve(values.out);
  if (out !== undefined && values.inline)
    throw new CommandError("bad_args", "--out and --inline pick opposite outputs; give one");
  // One element on the page, for commands that act on or read one.
  const element = {
    ref: values.ref,
    selector: values.selector,
    role: values.role,
    name: values.name,
    exact: values.exact,
    nth: values.nth,
    label: values.label,
    text: values.text,
    frame: values.frame,
  };
  const hasLocator = [values.selector, values.role, values.label, values.text].some((value) => value !== undefined);
  const refuseExtra = (allowed: number) => {
    if (rest.length > allowed)
      throw new CommandError("bad_args", `${verb} takes at most ${allowed} arguments, got ${rest.length}`);
  };

  let command: CommandName;
  let args: CommandArgs = {};
  let shouldStartDaemon = true;
  switch (verb) {
    case "open":
      refuseExtra(1);
      command = "open";
      args = { url: rest[0], wait: values.wait, isolated: values.isolated };
      break;
    case "tabs":
      refuseExtra(0);
      command = "tabs";
      args = { all: values.all };
      break;
    case "switch":
      refuseExtra(1);
      command = "switch";
      args = { tab: need(0, "tab") };
      break;
    case "close":
      refuseExtra(1);
      command = "close";
      args = { tab: rest[0] };
      break;
    case "goto":
      refuseExtra(1);
      command = "goto";
      args = { url: need(0, "url"), wait: values.wait };
      break;
    case "snapshot":
      refuseExtra(0);
      command = "snapshot";
      args = { inline: values.inline, out };
      break;
    case "screenshot":
      refuseExtra(0);
      command = "screenshot";
      args = { full: values.full, ...element, out };
      break;
    case "text":
      refuseExtra(0);
      command = "text";
      args = { ...element, inline: values.inline, out };
      break;
    case "eval":
      refuseExtra(1);
      command = "eval";
      args = { js: need(0, "js"), mainWorld: values["main-world"], inline: values.inline, out };
      break;
    case "click":
      refuseExtra(1);
      command = "click";
      if (rest[0] === undefined && values.ref === undefined && !hasLocator && values.at === undefined) need(0, "ref");
      args = { ...element, ref: rest[0] ?? values.ref, at: values.at };
      break;
    case "fill":
      // With a locator flag the only positional is the text.
      command = "fill";
      if (hasLocator) {
        refuseExtra(1);
        args = { ...element, fillText: need(0, "text") };
      } else {
        refuseExtra(2);
        args = { ...element, ref: need(0, "ref"), fillText: need(1, "text") };
      }
      break;
    case "type":
      refuseExtra(1);
      command = "type";
      args = { text: need(0, "text") };
      break;
    case "challenge":
      refuseExtra(0);
      command = "challenge";
      args = { handoff: values.handoff };
      break;
    case "press":
      refuseExtra(1);
      command = "press";
      args = { key: need(0, "key") };
      break;
    case "extract":
      refuseExtra(1);
      command = "extract";
      args = { schema: schemaArg(need(0, "schema")), ...element, inline: values.inline, out };
      break;
    case "wait":
      refuseExtra(0);
      command = "wait";
      if (values.ref !== undefined)
        throw new CommandError(
          "bad_args",
          "wait does not take a ref",
          "wait for a locator, a URL or a title; refs go stale when the page changes",
        );
      args = { ...element, url: values.url, title: values.title, load: values.load, gone: values.gone };
      break;
    case "watch":
      refuseExtra(0);
      command = "watch";
      args = {
        events: values.events,
        url: values.url,
        count: values.count === undefined ? undefined : Number(values.count),
      };
      if (args.count !== undefined && (!Number.isInteger(args.count) || Number(args.count) <= 0))
        throw new CommandError("bad_args", `--count must be a positive integer, got ${values.count}`);
      break;
    case "completions": {
      refuseExtra(1);
      const shell = need(0, "shell");
      if (shell !== "zsh")
        throw new CommandError("bad_args", `completions for ${shell} are not available`, "completions zsh");
      return { kind: "completions", shell };
    }
    case "network": {
      const action = need(0, "list|get|har");
      if (action === "list") {
        refuseExtra(1);
        command = "network-list";
        args = { url: values.url, type: values.type, status: values.status, inline: values.inline, out };
      } else if (action === "get") {
        refuseExtra(2);
        command = "network-get";
        if (rest[1] === undefined && values.url === undefined) need(1, "id");
        args = { id: rest[1], url: values.url, body: values.body, inline: values.inline, out };
      } else if (action === "har") {
        refuseExtra(2);
        const harAction = need(1, "start|stop");
        if (harAction !== "start" && harAction !== "stop")
          throw new CommandError("bad_args", `network har ${harAction} is not a command`, "network har start|stop");
        command = harAction === "start" ? "network-har-start" : "network-har-stop";
        args = { out };
      } else {
        throw new CommandError("bad_args", `network ${action} is not a command`, "network list|get|har");
      }
      break;
    }
    case "route": {
      const action = need(0, "block|mock|list|clear");
      if (action === "block") {
        refuseExtra(2);
        command = "route-block";
        args = { glob: need(1, "glob") };
      } else if (action === "mock") {
        refuseExtra(3);
        command = "route-mock";
        args = { glob: need(1, "glob"), file: resolve(need(2, "file")) };
      } else if (action === "list" || action === "clear") {
        refuseExtra(1);
        command = action === "list" ? "route-list" : "route-clear";
      } else {
        throw new CommandError("bad_args", `route ${action} is not a command`, "route block|mock|list|clear");
      }
      break;
    }
    case "login":
      refuseExtra(1);
      command = "login";
      args = { url: need(0, "url"), until: values.until };
      break;
    case "cookies":
      refuseExtra(0);
      command = "cookies";
      args = { domain: values.domain, inline: values.inline, out };
      break;
    case "state": {
      const action = need(0, "save|load|import|export");
      refuseExtra(action === "export" ? 3 : 2);
      if (action === "export") {
        command = "state-export";
        args = { site: need(1, "site"), file: resolve(need(2, "file")) };
        break;
      }
      if (action === "import") {
        command = "state-import";
        // The CLI's environment names the Chrome to read, not the long-running daemon's.
        args = { site: need(1, "site"), from: values.from, chromeUserDataDir: chromeUserDataDirFrom(env) };
        break;
      }
      if (action !== "save" && action !== "load")
        throw new CommandError(
          "bad_args",
          `state ${action} is not a command`,
          "state save|load <file>, state import <site> [--from <chrome-profile>], state export <site> <file>",
        );
      command = action === "save" ? "state-save" : "state-load";
      args = { file: resolve(need(1, "file")) };
      break;
    }
    case "console":
      refuseExtra(0);
      command = "console";
      args = { level: values.level, follow: values.follow, inline: values.inline, out };
      break;
    case "errors":
      refuseExtra(0);
      command = "errors";
      args = { inline: values.inline, out };
      break;
    case "trace": {
      refuseExtra(1);
      const action = need(0, "start|stop");
      if (action !== "start" && action !== "stop")
        throw new CommandError("bad_args", `trace ${action} is not a command`, "trace start|stop");
      command = action === "start" ? "trace-start" : "trace-stop";
      args = { out };
      break;
    }
    case "cdp":
      refuseExtra(2);
      if (rest[0] === "help") {
        command = "cdp-help";
        args = { topic: rest[1], inline: values.inline, out };
        break;
      }
      command = "cdp";
      args = { method: need(0, "Domain.method"), params: rest[1], inline: values.inline, out };
      break;
    case "devtools-url":
      refuseExtra(0);
      command = "devtools-url";
      break;
    case "profile": {
      refuseExtra(2);
      const action = need(0, "create");
      if (action !== "create")
        throw new CommandError(
          "bad_args",
          `profile ${action} is not a command`,
          "profile create <name> --mode stealth|debug",
        );
      const name = need(1, "name");
      if (!isValidName(name))
        throw new CommandError(
          "bad_args",
          `invalid profile name ${name}`,
          "use letters, digits, dot, dash, underscore",
        );
      if (values.mode === undefined || !isProfileMode(values.mode))
        throw new CommandError("bad_args", `profile create needs --mode ${profileModes.join("|")}`);
      return { kind: "create-profile", profile: name, mode: values.mode, isJson: values.json };
    }
    case "session":
      if (rest[0] === "history") {
        refuseExtra(2);
        if (rest[1] !== undefined && rest[1] !== "clear")
          throw new CommandError(
            "bad_args",
            `session history ${rest[1]} is not a command`,
            "session history [--format sh|jsonl] [--out <file>], session history clear",
          );
        const format = values.format ?? "sh";
        if (!isHistoryFormat(format))
          throw new CommandError("bad_args", `--format must be one of ${historyFormats.join(", ")}, got ${format}`);
        return {
          kind: "history",
          profile,
          session: values.session ?? sessionFallback(),
          format,
          out,
          isClear: rest[1] === "clear",
          isJson: values.json,
        };
      }
      if (rest[0] === "close") {
        refuseExtra(2);
        command = "session-close";
        args = { pattern: rest[1] };
        shouldStartDaemon = false;
      } else if (rest[0] === "label") {
        refuseExtra(2);
        command = "session-label";
        args = { label: need(1, "text") };
      } else {
        refuseExtra(0);
        command = "session";
      }
      break;
    case "sessions":
      refuseExtra(1);
      command = "sessions";
      args = { pattern: rest[0] };
      shouldStartDaemon = false;
      break;
    case "daemon": {
      refuseExtra(1);
      const action = need(0, "status|stop|logs");
      if (action === "logs") return { kind: "logs", profile, isJson: values.json };
      if (action !== "status" && action !== "stop")
        throw new CommandError("bad_args", `daemon ${action} is not a command`, "daemon status|stop|logs");
      command = action === "status" ? "daemon-status" : "daemon-stop";
      shouldStartDaemon = false;
      break;
    }
    case "pipe":
      refuseExtra(0);
      return { kind: "pipe", profile, session: values.session ?? sessionFallback(), isBail: values.bail };
    case "audit": {
      refuseExtra(0);
      const count = values.count === undefined ? 20 : Number(values.count);
      if (!Number.isInteger(count) || count <= 0)
        throw new CommandError("bad_args", `--count must be a positive integer, got ${values.count}`);
      return { kind: "audit", count, isJson: values.json };
    }
    case undefined:
      throw new CommandError("bad_args", "no command given", usage);
    default:
      throw new CommandError("bad_args", `unknown command ${verb}`, usage);
  }

  return {
    profile,
    session: values.session ?? sessionFallback(),
    isJson: values.json,
    timeoutMs,
    command,
    args,
    shouldStartDaemon,
  };
}

// The daemon runs in another directory, so file paths leave the CLI absolute. Inline JSON passes through.
function schemaArg(raw: string): string {
  return raw.trimStart().startsWith("{") ? raw : resolve(raw);
}

// These never touch the daemon: logs, audit and history read files, and a profile must exist before its
// daemon starts.
export async function localActionData(
  action: Exclude<LocalAction, { kind: "completions" | "pipe" }>,
): Promise<CommandData> {
  switch (action.kind) {
    case "logs": {
      const { logPath } = profilePaths(action.profile);
      const lines = (await readFile(logPath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== "")
        .slice(-50);
      return { lines, fields: { path: logPath, lines } };
    }
    case "audit": {
      const { entries, unreadableLines } = await readAuditLog(auditLogPathFrom());
      const shown = entries.slice(-action.count);
      const lines = [
        ...(entries.length === 0 ? ["no copies recorded"] : shown.map(auditLine)),
        ...(unreadableLines.length > 0
          ? [`unreadable lines in ${auditLogPathFrom()}: ${unreadableLines.join(" ")}`]
          : []),
      ];
      return { lines, fields: { path: auditLogPathFrom(), entries: shown, unreadableLines } };
    }
    case "create-profile": {
      if (!isProfileMode(action.mode))
        throw new CommandError("bad_args", `mode must be one of ${profileModes.join(", ")}`);
      const { mode, isNew } = await fixProfileMode(profilePaths(action.profile), action.profile, action.mode);
      const line = `${isNew ? "created" : "exists"} ${mode} profile ${action.profile}`;
      return { lines: [line], fields: { profile: action.profile, mode, isNew } };
    }
    case "history": {
      const path = join(profilePaths(action.profile).sessionsDir, sessionFolderName(action.session), historyFileName);
      const steps = await readHistory(path);
      if (action.isClear) {
        await clearHistory(path);
        return {
          lines: [`cleared ${steps.length} steps from session ${action.session}`],
          fields: { session: action.session, clearedSteps: steps.length },
        };
      }
      const script = formatHistory(steps, action.format, { session: action.session, profile: action.profile });
      if (action.out === undefined)
        return { lines: [script], fields: { session: action.session, format: action.format, steps, script } };
      await writeFile(action.out, `${script}\n`, { mode: action.format === "sh" ? 0o755 : 0o644 });
      return {
        lines: [`history: ${action.out}`, `steps: ${steps.length}`],
        fields: { session: action.session, format: action.format, steps, path: action.out },
      };
    }
  }
}

function print(response: DaemonResponse, isJson: boolean): number {
  if (response.ok) {
    process.stdout.write(
      isJson ? `${JSON.stringify({ ok: true, data: response.data.fields })}\n` : `${response.data.lines.join("\n")}\n`,
    );
    return 0;
  }
  const { error } = response;
  if (isJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
  } else {
    process.stderr.write(`error ${error.code}: ${error.message}\n${error.hint ? `hint: ${error.hint}\n` : ""}`);
  }
  return exitCodeFor(error.code);
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "__daemon") {
    const profileFlagIndex = argv.indexOf("--profile");
    const profile = profileFlagIndex === -1 ? "stealth" : argv[profileFlagIndex + 1];
    if (profile === undefined || !isValidName(profile))
      throw new Error(`__daemon needs a valid --profile, got ${String(profile)}`);
    // Loaded here only: Patchright takes most of a CLI call's startup time, and clients never need it.
    const { isClosedTargetRejection, runDaemon } = await import("./daemon.ts");
    process.on("unhandledRejection", (reason) => {
      if (!isClosedTargetRejection(reason)) throw reason;
      process.stdout.write(
        `${new Date().toISOString()} ignored a rejection from a closed target: ${String(reason).split("\n")[0]}\n`,
      );
    });
    await runDaemon(profile);
    return new Promise(() => {});
  }

  const isJson = argv.includes("--json");
  const sessionFallback = () => resolveSessionName(process.env, process.ppid, lookupProcess);
  try {
    const parsed = parseCli(argv, process.env, sessionFallback);
    if ("kind" in parsed) {
      switch (parsed.kind) {
        case "completions":
          process.stdout.write(zshCompletionScript);
          return 0;
        case "pipe":
          return await runPipe({
            input: process.stdin,
            output: process.stdout,
            runner: new CommandRunner(process.env, () => parsed.session),
            isBail: parsed.isBail,
          });
        case "logs":
        case "audit":
        case "create-profile":
        case "history":
          return print({ id: 0, ok: true, data: await localActionData(parsed) }, parsed.isJson);
      }
    }
    const connection = new DaemonConnection(parsed.profile);
    try {
      const response = await connection.request({
        ...parsed,
        argv,
        onStream: (stream) => process.stdout.write(`${parsed.isJson ? JSON.stringify(stream.fields) : stream.line}\n`),
      });
      return print(response, parsed.isJson);
    } finally {
      connection.close();
    }
  } catch (err) {
    return print({ id: 0, ok: false, error: toCommandError(err).toBody() }, isJson);
  }
}

// bin/patchrome.js calls runCli; the daemon is spawned with this file as the entry script.
export const runCli = main;

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
