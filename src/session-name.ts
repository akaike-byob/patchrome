import { execFileSync } from "node:child_process";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  tty: string;
}

export type ProcessLookup = (pid: number) => ProcessInfo | undefined;

const shellCommands = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "nu", "env", "node", "npx", "npm", "pnpm", "bun"]);

// Claude Code and Codex run each tool call in a fresh shell, so the direct parent pid changes per command.
// The first ancestor that is not a shell or a Node launcher is the agent or terminal, and outlives the call.
export function resolveSessionName(env: NodeJS.ProcessEnv, startPid: number, lookup: ProcessLookup): string {
  if (env.PATCHROME_SESSION) return env.PATCHROME_SESSION;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-${env.CLAUDE_CODE_SESSION_ID}`;

  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const info = lookup(pid);
    if (!info) break;
    const commandName = info.command.split("/").pop()?.replace(/^-/, "") ?? "";
    const hasTty = info.tty !== "" && info.tty !== "??" && info.tty !== "?";
    if (hasTty) return `tty-${info.tty.replace(/^\/dev\//, "")}`;
    if (!shellCommands.has(commandName)) return `pid-${info.pid}`;
    pid = info.ppid;
  }
  return `pid-${startPid}`;
}

export function lookupProcess(pid: number): ProcessInfo | undefined {
  try {
    const line = execFileSync("ps", ["-o", "pid=,ppid=,tty=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return undefined;
    return { pid: Number(match[1]), ppid: Number(match[2]), tty: match[3] ?? "", command: match[4] ?? "" };
  } catch {
    return undefined;
  }
}
