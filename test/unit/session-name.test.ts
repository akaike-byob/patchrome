import { describe, expect, it } from "vitest";
import { resolveSessionName, type ProcessInfo } from "../../src/session-name.ts";

function processTable(rows: ProcessInfo[]) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return (pid: number) => byPid.get(pid);
}

describe("resolveSessionName", () => {
  const table = processTable([
    { pid: 300, ppid: 200, command: "/bin/zsh", tty: "??" },
    { pid: 200, ppid: 100, command: "claude", tty: "??" },
    { pid: 100, ppid: 1, command: "wezterm-gui", tty: "??" },
  ]);

  it("prefers PATCHROME_SESSION over everything", () => {
    expect(resolveSessionName({ PATCHROME_SESSION: "mine", CLAUDE_CODE_SESSION_ID: "abc" }, 300, table)).toBe("mine");
  });

  it("uses the Claude Code session id when present", () => {
    expect(resolveSessionName({ CLAUDE_CODE_SESSION_ID: "abc" }, 300, table)).toBe("claude-abc");
  });

  it("skips the per-call shell and names the first non-shell ancestor", () => {
    expect(resolveSessionName({}, 300, table)).toBe("pid-200");
  });

  it("uses the controlling tty for a human terminal", () => {
    const terminal = processTable([
      { pid: 500, ppid: 400, command: "-zsh", tty: "ttys008" },
      { pid: 400, ppid: 1, command: "login", tty: "ttys008" },
    ]);
    expect(resolveSessionName({}, 500, terminal)).toBe("tty-ttys008");
  });

  it("falls back to the start pid when the process table has no entry", () => {
    expect(resolveSessionName({}, 999, table)).toBe("pid-999");
  });
});
