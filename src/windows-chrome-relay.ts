import { execFileSync, spawn } from "node:child_process";
import { Socket } from "node:net";
import { encodedPowerShell } from "./host-prompts-wsl.ts";
import { ProtocolMessages, relayScript, windowsCommandLine, withWindowsPaths } from "./windows-chrome.ts";

// Playwright runs this, through the launcher, as if it were Chrome: fd 3 carries requests and fd 4 responses.
// argv: chrome.exe's Windows path, then Playwright's Chrome arguments.
const [chromePath, ...chromeArgs] = process.argv.slice(2);
if (chromePath === undefined) throw new Error("usage: windows-chrome-relay <chrome.exe path> [chrome args...]");

// Sync, so requests reach Chrome in the order Playwright sent them. Only a launch and the rare request that
// names a file wait on it.
const windowsPathOf = (wslPath: string) => execFileSync("wslpath", ["-w", wslPath], { encoding: "utf8" }).trim();

const userDataDirFlag = "--user-data-dir=";
const windowsArgs = chromeArgs.map((arg) =>
  arg.startsWith(userDataDirFlag) ? `${userDataDirFlag}${windowsPathOf(arg.slice(userDataDirFlag.length))}` : arg,
);
const powerShell = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedPowerShell(relayScript(chromePath, windowsCommandLine(windowsArgs))),
  ],
  { stdio: ["pipe", 4, "inherit"] },
);

// Responses go straight from PowerShell to fd 4. Requests pass through here, because a download folder or an
// uploaded file is a Linux path that the Windows Chrome cannot open until it is rewritten. A socket reads fd 3
// on the event loop; an fs stream would park a threadpool thread in read(), and exit waits for that thread
// until Playwright gives up on closing and kills the relay.
const requests = new Socket({ fd: 3, readable: true, writable: false });
const toPowerShell = powerShell.stdin;
if (toPowerShell === null) throw new Error("powershell.exe started without a stdin pipe");
const messages = new ProtocolMessages((message) => {
  if (!toPowerShell.write(withWindowsPaths(message, windowsPathOf))) {
    requests.pause();
    toPowerShell.once("drain", () => requests.resume());
  }
});
requests.on("data", (chunk) => messages.push(chunk as Buffer));
requests.on("end", () => toPowerShell.end());
// PowerShell exiting closes its stdin under a request still in flight; the exit below reports it.
toPowerShell.on("error", () => {});
powerShell.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => powerShell.kill(signal));
