import type { ReplayHint } from "./history.ts";

// Wire format between the CLI and the daemon: one JSON object per line over a unix socket.

export const errorCodes = [
  "tab_gone",
  "ref_stale",
  "timeout",
  "navigation_failed",
  "unsupported_in_stealth",
  "daemon_unreachable",
  "daemon_outdated",
  "bad_args",
  "copy_denied",
  "no_display",
  "setup_required",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const commandNames = [
  "open",
  "tabs",
  "switch",
  "close",
  "goto",
  "snapshot",
  "click",
  "fill",
  "press",
  "type",
  "challenge",
  "screenshot",
  "text",
  "eval",
  "extract",
  "wait",
  "watch",
  "network-list",
  "network-get",
  "network-har-start",
  "network-har-stop",
  "route-block",
  "route-mock",
  "route-list",
  "route-clear",
  "login",
  "cookies",
  "state-save",
  "state-load",
  "state-import",
  "state-export",
  "console",
  "errors",
  "trace-start",
  "trace-stop",
  "cdp",
  "cdp-help",
  "devtools-url",
  "session",
  "sessions",
  "session-close",
  "session-label",
  "daemon-status",
  "daemon-stop",
] as const;
export type CommandName = (typeof commandNames)[number];

export function isCommandName(value: string): value is CommandName {
  return (commandNames as readonly string[]).includes(value);
}

export type CommandArgs = Record<string, string | number | boolean | undefined>;

export interface DaemonRequest {
  id: number;
  session: string;
  command: CommandName;
  args: CommandArgs;
  timeoutMs: number;
  // The words the caller typed, kept in the session's history. Absent from callers that type no words.
  argv?: string[];
  buildId: string;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type DaemonResponse = { id: number; ok: true; data: CommandData } | { id: number; ok: false; error: ErrorBody };

// A streaming command such as `console --follow` sends these before its final response.
export interface DaemonStreamLine {
  id: number;
  stream: { line: string; fields: Record<string, unknown> };
}

// Every command answers with plain lines for humans and agents, plus structured fields for --json.
export interface CommandData {
  lines: string[];
  fields: Record<string, unknown>;
  // How the command replays from history; the daemon keeps it and never sends it.
  replay?: ReplayHint;
}

export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }

  toBody(): ErrorBody {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }
}

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "bad_args":
      return 2;
    case "tab_gone":
    case "ref_stale":
    case "timeout":
    case "navigation_failed":
    case "unsupported_in_stealth":
    case "daemon_unreachable":
    case "daemon_outdated":
    case "copy_denied":
    case "no_display":
    case "setup_required":
      return 1;
  }
}
